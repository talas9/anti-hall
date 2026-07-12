---
name: devswarm
description: Explain and activate anti-hall's optional DevSwarm integration — the hivecontrol reference KB, the (designed, unbuilt) workspace-tier orchestration, and the shipped layered recovery model (child self-report → supervisor poke → escalate-to-parent, automatic path NEVER kills) plus the on-demand devswarm-recover CLI (the only path that ever kills). Use when the user asks "explain the anti-hall DevSwarm integration", "how do I activate the DevSwarm supervisor", "what DevSwarm addons does anti-hall have", "tune the liveness supervisor", "recover a stuck DevSwarm workspace", or anything about hivecontrol / DevSwarm workspaces from an anti-hall angle.
---

# DevSwarm integration

anti-hall's DevSwarm support is **entirely optional and feature-detected** — the same
model as its OMC/OMX integration. Nothing here changes behavior unless DevSwarm is
actually in use (`DEVSWARM_REPO_ID` set, or a published workspace descriptor exists).
anti-hall ships only generic, project-agnostic pieces; any DevSwarm-consumer-side glue
(an inbox daemon, a done-report contract, `hivecontrol` wiring) belongs to whatever
project is running DevSwarm, not to this plugin.

## The four addons

| Addon | Status | Where |
|---|---|---|
| **hivecontrol reference KB** | Reference doc | `docs/KB-devswarm-hivecontrol.md` — the `hivecontrol` CLI surface, `.devswarm/config.json` schema, `DEVSWARM_*` env vars, and the async message-passing coordination model. Repo-clone-only (like all `docs/`, it does not ship with `/plugin install`). |
| **Workspace-tier orchestration** | **Designed, NOT built** | `docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md`. Would make the `orchestration` skill workspace-topology-aware (a Primary workspace fans out to child workspaces via `hivecontrol`; children never spawn grandchildren). Do not describe this as active. |
| **Liveness supervisor (detect → poke → escalate, never kills)** | **Shipped** | `companion/devswarm-supervisor.js`, `companion/install-devswarm-supervisor.js`, `companion/lib/{liveness,recovery,target-session,doctor-devswarm}.js`, `hooks/lib/devswarm-detect.js`, `hooks/lib/devswarm-role.js`, `hooks/devswarm-child-role.js`. The automatic background sweep. See "The layered recovery model" below. |
| **On-demand recovery CLI (the ONLY kill path)** | **Shipped** | `companion/devswarm-recover.js`. Invoked explicitly, per workspace id, by an operator (or a parent orchestrator acting on an escalation). See "On-demand recovery" below. |

## command-guard's destructive-read redirect (shipped, v0.53.0)

Separate from the four addons above — this lives in the always-on `command-guard.js`
hook, not in the DevSwarm companion. Under a DevSwarm-active session, `command-guard`
redirects the two CONSUMING native `hivecontrol` inbox reads, in ALL contexts (a
delegated subagent read drains the queue identically): `hivecontrol workspace monitor`
blocks UNCONDITIONALLY (a no-timeout long-poll that hangs the shell and consumes the
queue); `hivecontrol workspace read-messages` blocks ONLY when durable-inbox evidence
exists — `ANTIHALL_DEVSWARM_INBOX_CMD` set, or a
`~/.anti-hall/devswarm/workspaces/*.json` descriptor with a truthy `inboxPath` — so a
harmless single-consumer `read-messages` is still allowed. Non-destructive
`message-count`/`message-parent`/`message-child` are untouched. It has its own
`devswarm-read-guard` skip name (in skip-guard's `DESTRUCTIVE` set, so a blanket `all`
skip does not cover it) and is fail-open. Full detail: `docs/KB-devswarm-hivecontrol.md`
§8.5.

## What this is for

A workaround for a documented, unresolved Claude Code core-loop bug class
(`anthropics/claude-code#39755`, related: `#28482`, `#33949`): a `claude` session can go
**wedged** — process alive, listener dead — with no crash for pm2/systemd to restart and
no background-task-timeout event to generate a new turn. DevSwarm child workspaces run
headless and unattended, so a wedge there just sits forever.

## The layered recovery model

Three layers, escalating in scope. **The automatic path stops at Layer 3 — it never
kills a process.** Only the separate on-demand CLI (below) ever does that.

**Layer 1 — child self-report (child-workspace only).** A child workspace's own
`SessionStart` hook (`hooks/devswarm-child-role.js`) injects a reminder: if the session
has been idle with no active task, proactively run `hivecontrol workspace message-parent`
to report "idle — reassign me or archive me," so the parent's task list stays honest
instead of the child sitting unnoticed. This is **cooperative** — it only works if the
child is still capable of executing a turn at all. A truly wedged child (the failure mode
this whole feature exists for) cannot self-report; that's what Layers 2–3 are for.

**Layer 2 — supervisor poke.** The background sweep (`devswarm-supervisor.js`) computes
liveness per published workspace descriptor (`companion/lib/liveness.js`'s
`computeLiveness`). On a `stale` verdict (both outbound signals — transcript mtime AND
git activity — idle past threshold, AND a pending unread inbox backlog), it calls
`pokeOrEscalate()` (`companion/lib/recovery.js`). If the descriptor carries an optional
`nudgeCommand` (an argv array) and the attempt budget/cooldown allow it, the sweep fires
that command (detached, best-effort, no output captured) and persists verdict `nudged`.
The next sweep checks whether the outbound signal advanced past `nudgedAt` — if so, the
poke worked and the verdict clears to `alive`.

**Layer 3 — escalate-to-parent.** Once the nudge budget is exhausted (or there's no
`nudgeCommand` at all, or the workspace is still cooling down out of budget),
`pokeOrEscalate()` persists verdict `escalated` and fires the descriptor's optional
`escalateCommand` once. `escalated` is a **terminal** verdict — `computeLiveness`
short-circuits it (returns unchanged, never re-stats) so the sweep stops re-targeting a
workspace a human/parent must now handle. Reset it by deleting
`~/.anti-hall/devswarm/liveness/<id>.json` after someone has looked.

**Automatic path stops here.** Nothing above ever resolves a pid or sends a signal.

## Role scoping

Layer 1 (self-report) only fires for a workspace that is BOTH a DevSwarm session AND a
child in the hivecontrol topology — never for the Primary session, and never inside a
subagent (subagents are handled by anti-hall's own `verify-first-subagent`, unrelated to
this feature).

| Role | `DEVSWARM_SOURCE_BRANCH` | Self-reports (Layer 1)? |
|---|---|---|
| Primary (root workspace) | empty/unset | No |
| Child workspace | set (non-empty) | Yes |
| Subagent (any workspace) | n/a | No — out of scope for this hook |

Gated by `hooks/lib/devswarm-role.js`'s `isChildWorkspace(env)` (topology: is this
session a child?) combined with `hooks/lib/devswarm-detect.js`'s `isDevswarmActive(env)`
(feature gate: is DevSwarm active at all?) — both must be true for the `SessionStart`
hook (`hooks/devswarm-child-role.js`) to inject anything; otherwise it's a silent no-op,
byte-identical to a non-DevSwarm session.

## On-demand recovery — devswarm-recover CLI

```bash
node plugins/anti-hall/companion/devswarm-recover.js <workspace-id>
```

This is **the only place in DevSwarm that ever kills a process.** It reads the named
workspace's published descriptor, resolves the target `claude` process, and — if exactly
one candidate confirms — kills it (SIGTERM, then SIGKILL after a grace window if it
survives and still re-confirms) plus its process group, then resumes it headless
(`claude -p --resume <uuid>`) from the same worktree cwd, feeding the unread inbox
backlog as the fresh prompt.

**When to use it:** on an `escalated` workspace (Layer 3 was reached and nothing
resolved it), or any time an operator/parent orchestrator wants to force-recover one
named workspace right now.

It applies the **same confirm-gate safety** the old always-on supervisor used to apply
automatically, with one deliberate relaxation:
- Exactly-one-or-abstain: 0 or >1 candidate matches both abstain (never guesses).
- Identity-bound: argv session id must equal the descriptor's `sessionId`, cwd must equal
  `worktreePath`.
- TOCTOU re-confirm: identity is re-derived on fresh data immediately before SIGTERM AND
  again before SIGKILL — a pid recycled during the grace window is never wrongly killed.
- Single-writer lock per workspace (atomic lockfile) — never resumes the same session id
  from two processes concurrently; a dead/stale holder is stolen so a crashed prior run
  can't permanently block recovery.
- Cap at `ANTIHALL_DEVSWARM_MAX_RECOVERIES` (default 3) — escalates instead of looping.
- **The relaxation:** this CLI targets **INTERACTIVE sessions too**, not just headless
  ones (`allowInteractive: true`, set only here) — naming the workspace id on the command
  line IS the deliberate human override that makes touching an interactive session safe.
  The automatic sweep never has this permission.
- Windows: escalate-only, never kills (the cwd confirm-gate is unavailable there).

**Resume guardrail:** every resumed prompt is prepended with a fixed instruction
(`RESUME_GUARDRAIL` in `companion/lib/recovery.js`) telling the resumed model to verify
via a read-only check (git status/log, file mtime, log tail) whether an interrupted
mutating command already completed, before blindly re-running it — a real mid-turn-kill
test showed the resumed model otherwise double-executed a command it couldn't confirm had
already succeeded.

Exit code 0 on any handled outcome (`resumed` / `escalate` / `abstain` / `skip`) — these
are all legitimate, non-error results read from stdout. Non-zero only on an internal
error (bad/unsafe argv, unreadable descriptor, an internal throw past the fail-open
guards).

## Activation checklist (for a consumer/orchestrator)

This is the part a DevSwarm-consuming project needs, in order:

**1. Install the automatic supervisor (opt-in — never self-installs):**

```bash
node plugins/anti-hall/companion/install-devswarm-supervisor.js
node plugins/anti-hall/companion/install-devswarm-supervisor.js --dry-run   # preview
node plugins/anti-hall/companion/install-devswarm-supervisor.js --uninstall
```

- **macOS** → LaunchAgent (`launchd`, `StartInterval`).
- **Linux** → `systemd --user` timer; cron fallback (coalesced by the supervisor's own
  single-flight sweep lock) if `systemctl` is absent.
- **Windows** → detection-only, documented no-op for recovery. A running process's cwd
  is not obtainable in pure Node on Windows, so the cwd confirm-gate cannot run there.
- **Autonomous refresh:** the `update` skill runs this installer's `how` command
  automatically (no offer, no ask) whenever an update happens inside an active DevSwarm
  session (`isDevswarmActive(process.env)`), so a fresh install always carries the
  current build's poke/escalate logic. It's idempotent (`launchctl unload && load` /
  systemd reload), so it both first-installs and refreshes.

**1b. Install the ingest daemon (new in 0.54.1 — same autonomous-refresh posture):**

```bash
node plugins/anti-hall/companion/install-devswarm-ingest.js
node plugins/anti-hall/companion/install-devswarm-ingest.js --dry-run   # preview
node plugins/anti-hall/companion/install-devswarm-ingest.js --uninstall
```

`devswarm-ingest.js` is the one supervised daemon wrapping `hivecontrol workspace
monitor` into the substrate store (see `docs/KB-devswarm-hivecontrol.md` §8.7) — it
shipped in 0.54.0 but nothing auto-started it until this installer landed in 0.54.1.
Unlike the supervisor (a periodic sweep on `StartInterval`/`.timer`), the ingest daemon
runs **continuously**, so this installer schedules re-exec-on-exit instead: macOS
LaunchAgent with `KeepAlive`; Linux `systemd --user` `.service` with `Restart=always`
(cron fallback — every minute, restart-if-dead — when `systemctl` is absent, giving a
cron-only Linux host up to ~60s of revive gap after a crash). Distinct label
(`com.anti-hall.devswarm-ingest`) and log (`~/.anti-hall/devswarm-ingest.log`) from the
supervisor. Idempotent and safe to install redundantly — the daemon's own
single-consumer lock means only one instance ever actually runs. Windows: documented
no-op (no pure-Node long-running user-level scheduler; run the daemon manually if
needed). Same **autonomous refresh** as the supervisor installer: the `update` skill
runs its `how` command automatically (no offer, no ask) inside an active DevSwarm
session, so a fresh update always carries a running, current-build ingest daemon.

**2. Publish a per-workspace descriptor** at
`~/.anti-hall/devswarm/workspaces/<id>.json`:

```json
{
  "id": "<safe id, [A-Za-z0-9._-]+>",
  "worktreePath": "<absolute path to the workspace's git worktree>",
  "sessionId": "<the claude session's current uuid>",
  "inboxPath": "<path to the durable inbound-message log>",
  "cursorPath": "<path to the consumer's read-cursor over that log>",
  "nudgeCommand": ["<optional argv[0]>", "<optional argv[1]>", "..."],
  "escalateCommand": ["<optional argv[0]>", "<optional argv[1]>", "..."]
}
```

- `id`, `worktreePath`, `sessionId` are **required** — a descriptor missing any of these,
  or carrying an unsafe `id` (must match `^[A-Za-z0-9._-]+$`, never `.`/`..`), is skipped
  entirely (fail-open: one bad descriptor never stops the sweep, it just never recovers).
- `inboxPath`/`cursorPath` are **load-bearing, not optional in practice**: without a
  readable inbox+cursor, the supervisor can never establish a pending unread backlog, so
  `pending` is always `false` and the workspace can never be nominated `stale` — Layer 2
  never fires no matter how wedged it is.
- `nudgeCommand`/`escalateCommand` are **optional argv arrays** the supervisor fires
  detached/best-effort (no output captured) at Layer 2/Layer 3 respectively — e.g. a
  script that pages an operator, or one that pings the parent orchestrator directly.
  Without `nudgeCommand`, a `stale` verdict escalates immediately (no poke attempt is
  possible); without `escalateCommand`, escalation still happens (verdict + recovery.log
  entry) — it just has no external side effect.

**3. Env gate.** `DISABLE_ANTIHALL_DEVSWARM=1` is the hard kill-switch. Note the
supervisor daemon's own gate (`devswarm-supervisor.js`) checks only that switch plus
`ANTIHALL_DEVSWARM_SUPERVISOR=off` — it does **not** require `DEVSWARM_REPO_ID`, because
that variable is per-session and is absent from a `launchd`/`systemd` background job. The
real activation signal for the daemon is simply the presence of descriptor files under
`~/.anti-hall/devswarm/workspaces/`. `DEVSWARM_REPO_ID` (and `ANTIHALL_DEVSWARM_SUPERVISOR=on`)
is what session-side consumers (`hooks/lib/devswarm-detect.js`, `doctor.js`,
`hooks/devswarm-child-role.js`) check instead.

**4. Keep the descriptor fresh:**
- `sessionId` must always be the workspace's **current** session uuid — if the consumer
  resumes into a new session id and doesn't update the descriptor, the confirm-gate finds
  zero candidates and abstains (never recovers, never false-positives either).
- **Delete the descriptor when the workspace closes** — there is no GC. A stale
  descriptor for a closed workspace just sits there abstaining forever (harmless, but
  noisy in `doctor.js`).
- `escalated` is a **terminal** verdict (the sweep stops re-targeting it once written) —
  reset it by deleting `~/.anti-hall/devswarm/liveness/<id>.json` once resolved (either by
  running `devswarm-recover.js <id>`, or after a human has otherwise handled it).

## Config / tuning env

**Automatic sweep** (resolved by `resolveThresholdsFromEnv()` in
`companion/devswarm-supervisor.js` — seconds in, ms out; invalid/absent values fall back
to the defaults below; both the live sweep and `doctor.js`'s DevSwarm section read
through it):

| Var | Default | Effect |
|---|---|---|
| `ANTIHALL_DEVSWARM_INTERVAL` | `90` (clamped 60–120) | Sweep interval in seconds, set at install time. |
| `ANTIHALL_DEVSWARM_SUPERVISOR` | `auto` | `off` disables the daemon gate; `on`/`auto` otherwise don't change daemon behavior (see gate note above) but do drive `devswarm-detect.js`'s session-side `active` signal. |
| `DISABLE_ANTIHALL_DEVSWARM` | unset | `1` = hard kill-switch, overrides everything. |
| `ANTIHALL_DEVSWARM_IDLE_SEC` | `900` (min 60) | Idle threshold (seconds) before a workspace is a stale candidate. |
| `ANTIHALL_DEVSWARM_COOLDOWN_SEC` | `600` (min 0) | Cooldown before a re-stale workspace is re-evaluated. |
| `ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` | `2` (clamped 1–20) | Poke attempts allowed before Layer 3 escalation. |
| `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` | `180` (min 1) | How long a poke stays "in effect" (held at `nudged`) before falling through to a fresh recompute. |
| `ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` | `120` (min 0) | Minimum gap between successive pokes. |

**On-demand CLI** (`devswarm-recover.js` resolves these itself, decoupled from the
sweep's env — the automatic path no longer carries them at all since it never kills):

| Var | Default | Effect |
|---|---|---|
| `ANTIHALL_DEVSWARM_MAX_RECOVERIES` | `3` (clamped 1–20) | Recoveries allowed before the CLI escalates instead. |
| `ANTIHALL_DEVSWARM_GRACE_SEC` | `5` (clamped 1–60) | SIGTERM→SIGKILL grace window. |

## Safety model

**Automatic path (never kills, no pid targeting):**
- Never resolves a pid, never sends a signal — its only tools are a soft nudge
  (an optional descriptor `nudgeCommand`) and an escalate signal (recovery.log line +
  optional `escalateCommand`).
- Fail-open end to end: any error is logged and the sweep continues; it never blocks on
  one bad descriptor.
- Single-flight: a process-wide sweep lock prevents overlapping sweeps from stacking
  (a cron fallback doesn't coalesce ticks the way launchd/systemd do).

**On-demand CLI (all the precise-kill safety, headless-OR-interactive):**
- Precise single-target kill or abstain — never a broad `pkill`. A survivor must be the
  confirmed `claude` process (identity-bound: argv session id == descriptor `sessionId`),
  cwd-confirmed to `worktreePath`.
- Confirm-gate: exactly one surviving candidate or abstain (0 or >1 candidates both
  abstain — never guess between them).
- Re-confirmed immediately before every signal (SIGTERM and again before SIGKILL), so a
  pid recycled mid-grace-window is never wrongly killed.
- Group-kill (POSIX negative pid) so orphaned MCP-server children go with it, not
  reparented to PID 1.
- Single-writer lock per workspace (atomic `wx` lockfile) — never resumes the same
  session id from two processes concurrently.
- Detached resume, no kill-on-timeout — a resumed session that's still starting is
  recorded `recovering`, never falsely `alive`.
- Targets headless **or** interactive sessions (see the relaxation above) — the only
  place in this feature where an interactive human takeover can be touched, and only
  because the operator named the id explicitly.
- **Windows**: escalate-only, never kills. (Detection-only for recovery generally.)

## Outputs to watch

- `~/.anti-hall/devswarm/liveness/<id>.json` — per-workspace verdict
  (`alive` / `stale` / `nudged` / `ambiguous` / `escalated`), nudge/recovery counts,
  timestamps.
- `~/.anti-hall/devswarm/recovery.log` — append-only NDJSON, one line per poke, escalate,
  recovery attempt, or abstain, with a reason.
- `node hooks/doctor.js` — silent unless DevSwarm is active; otherwise runs a live
  behavioral self-test (fresh workspace → `alive`, a constructed wedged fixture →
  `stale`) plus a PASS/WARN/FAIL readout per real workspace descriptor. `nudged` maps to
  WARN (a poke is outstanding, not yet a failure); there is no `recovering`/stuck-timer
  check any more — the automatic path never kills, so there's no kill-then-resume window
  to watch for being "stuck".

## When to use this skill

"Explain the anti-hall DevSwarm integration", "how do I activate the DevSwarm
supervisor", "what DevSwarm addons does anti-hall have", "tune the liveness supervisor",
"recover a stuck DevSwarm workspace", "is my DevSwarm workspace descriptor set up right".

## Relationship to other skills in this plugin

- **orchestration** — today's Workflow-tool + subagent fan-out is unaffected by any of
  this; the workspace-tier design (unbuilt) would eventually add a DevSwarm-aware branch
  there.
- **doctor** — surfaces the liveness supervisor's per-workspace health as one more
  section, silent when DevSwarm isn't in play.
- **update** — autonomously installs/refreshes the automatic supervisor AND (as of
  0.54.1) the ingest daemon when running inside an active DevSwarm session (see the
  activation checklist above).
