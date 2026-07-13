---
name: anti-hall-devswarm
description: Explain anti-hall's optional DevSwarm integration from Codex — the hivecontrol reference KB, the (designed, unbuilt) workspace-tier orchestration, and the shipped layered recovery model (Claude-side companion: child self-report → supervisor poke → escalate-to-parent, automatic path NEVER kills, plus the on-demand devswarm-recover CLI — the only kill path). Use when the user asks about DevSwarm, hivecontrol, or the anti-hall liveness supervisor while working in Codex.
---

# anti-hall DevSwarm integration (Codex view)

anti-hall's DevSwarm support is **optional and feature-detected**, same model as the
OMC/OMX integration: dormant, zero effect, unless DevSwarm is actually in use. anti-hall
ships only generic pieces; any DevSwarm-consumer glue (inbox daemon, done-report
contract, `hivecontrol` wiring) is the downstream project's, not this plugin's.

DevSwarm itself is **agent-agnostic** — `DEVSWARM_AI_AGENT` names the active in-workspace
agent (`claude`, `codex`, …), so a Codex session can be running inside a DevSwarm
workspace too. What follows is what a Codex user needs to know about the four addons.

## The four addons

| Addon | Status | Where |
|---|---|---|
| **hivecontrol reference KB** | Reference doc | `docs/KB-devswarm-hivecontrol.md` — the `hivecontrol` CLI surface, `.devswarm/config.json` schema, `DEVSWARM_*` env vars, and the parent/child async message-passing model. Includes a parallel OMC/OMX table for the workspace tier (§8.4 of the KB): the workspace-create/merge surface is CLI-identical either way; only the in-workspace fan-out engine differs (Workflow tool + subagents for Claude, `omx team`/workers for Codex). Repo-clone-only — does not ship with a plugin install. |
| **Workspace-tier orchestration** | **Designed, NOT built** | `docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md`. Nothing from this plan exists in the repo yet (no `devswarm-guard.js`/`devswarm-children.js`) — do not describe it as active in either OMC or OMX. |
| **Liveness supervisor (detect → poke → escalate, never kills)** | **Shipped — Claude-only** | `companion/devswarm-supervisor.js` + `install-devswarm-supervisor.js` + `companion/lib/{liveness,recovery,target-session,doctor-devswarm}.js` + `hooks/lib/devswarm-detect.js` + `hooks/lib/devswarm-role.js` + `hooks/devswarm-child-role.js`. The automatic background sweep. Recovers **wedged `claude` sessions specifically** (workaround for `claude-code#39755`) — it identity-binds to `claude -p --resume <uuid>` processes by argv, not Codex sessions. This section explains it for awareness; it is not a Codex-side capability. |
| **On-demand recovery CLI (the ONLY kill path)** | **Shipped — targets `claude` processes only** | `companion/devswarm-recover.js`, invoked explicitly per workspace id. Still Claude-only in what it targets (see below), but a Codex-side operator can run it. |

## The layered recovery model, for Codex users

Why it exists: a `claude` session inside a DevSwarm child workspace can go **wedged** —
process alive, listener dead, no crash for a restarter to catch, no timeout event to
generate a new turn (`anthropics/claude-code#39755`, related `#28482`/`#33949`). The
automatic path handles this in three escalating layers and **never kills anything**:

1. **Child self-report** — the child workspace's own Claude-side `SessionStart` hook
   (`hooks/devswarm-child-role.js`) reminds an idle child to proactively message its
   parent via `hivecontrol workspace message-parent`. Cooperative only — doesn't help a
   truly wedged child, which is what the next two layers are for. Codex has no
   equivalent hook; this only fires for a Claude session with `DEVSWARM_SOURCE_BRANCH` set.
2. **Supervisor poke** — the background sweep detects a `stale` workspace (both outbound
   signals idle past threshold, plus a pending unread backlog) and fires an optional
   descriptor-supplied `nudgeCommand`, persisting verdict `nudged`.
3. **Escalate-to-parent** — once the poke budget is exhausted, the sweep persists verdict
   `escalated` (terminal — never re-targeted) and fires an optional `escalateCommand`.

If your DevSwarm setup mixes Claude and Codex workspaces (`DEVSWARM_AI_AGENT` differs per
workspace), all of the above only ever touches the `claude` ones — it identity-binds to a
`claude` process's argv session id and cwd. A Codex workspace is simply outside its
target surface; nothing here signals or resumes a Codex process.

## command-guard's destructive-read redirect (shipped v0.53.0, later hardened — applies to Codex too)

Unlike the recovery model above, this one is **not** Claude-only: `command-guard.js` is
a single file registered in both `codex/hooks/hooks.json` and the Claude hooks.json, so
its DevSwarm branch fires identically for a Codex workspace. Under a DevSwarm-active
session it redirects the two CONSUMING native `hivecontrol` inbox reads, in ALL contexts
(a delegated read drains the queue identically): **both** `hivecontrol workspace
monitor` (a no-timeout long-poll that hangs the shell and consumes the queue) **and**
`hivecontrol workspace read-messages` (marks-read/drains the queue) now block
UNCONDITIONALLY whenever DevSwarm is active — the original evidence-gated carve-out for
`read-messages` (`ANTIHALL_DEVSWARM_INBOX_CMD` / a descriptor's `inboxPath`) has been
removed: a raw native `read-messages` desyncs the durable cursor regardless of whether a
durable inbox exists, so it is now treated exactly like `monitor`. Non-destructive
`message-count`/`message-parent`/`message-child` are untouched. Own
`devswarm-read-guard` skip name (in skip-guard's `DESTRUCTIVE` set — a blanket `all`
skip does not cover it). Full detail: `docs/KB-devswarm-hivecontrol.md` §8.5.

A second guard closes the RAW-file-read hole (`cat`/`head`/`grep`/… of the durable
inbox/store — doesn't drain the native queue, but desyncs the durable cursor and
violates the store's write/derive layering). The shell-verb form is caught by
`command-guard.js` itself — **shared, so this fires on Codex too.** The dedicated
`Read`-tool guard (`hooks/inbox-read-guard.js`) is **Claude-only** (not registered in
`codex/hooks/hooks.json` — it guards Claude's own `Read` tool specifically). Full
taxonomy: `docs/KB-devswarm-hivecontrol.md` §8.5.

## Child-side reception — `devswarm.js inbox pull` (shipped, v0.54.2)

Since the native reads are guard-redirected, the safe way a child RECEIVES parent messages
is `node scripts/devswarm.js inbox pull <DEVSWARM_BUILDER_ID>` — a bounded, guard-safe
one-shot drain (`command-guard`'s root-anchored `LIGHT_EXCEPTION` for `scripts/devswarm.js`
allows it inline; the CLI wrapper is invokable from either agent). It auto-ensures the
descriptor, then runs ONE pull: a **non-destructive `message-count` gate first** (count `0`
→ never calls `read-messages`), and only on count `>0` a single **bounded** `read-messages`
(finite 10 s timeout, **never `monitor`**), appended to the durable inbox NDJSON in one
atomic, hash-idempotent write plus a store-parity feed. **Residual limitations (honest):**
(1) `read-messages` marks-read BEFORE the durable append, so a crash in that window loses
the native messages — the count-gate minimizes but cannot close it (hivecontrol has no
non-destructive full read); a failed append surfaces `ok:false`, no partial NDJSON. (2)
Pull-not-push: reception latency = one turn (no background child drainer). The drain module
(`companion/lib/devswarm-pull.js`) and the durable inbox are Claude-side companion state, but
the CLI itself runs identically either way. Full detail: `docs/KB-devswarm-hivecontrol.md`
(v0.54.2 note).

## Always-listening reception + archive flow (Claude-side hooks; CLI is agent-agnostic)

Two v0.56.0 additions, split by what's Claude-only vs. what any agent can invoke:

- **Always-listening reception (Claude-only hooks, for awareness).** `hooks/devswarm-child-turn.js`
  (child, `UserPromptSubmit`) and `hooks/devswarm-child-gate.js` (child, `Stop`) are **not**
  registered in `codex/hooks/hooks.json` — like the rest of the layered recovery model, this is
  Claude-side tooling only. On the Claude side it now (1) mechanically writes/refreshes the
  child's own descriptor every turn (fixes #31 — the parent previously couldn't discover a
  child that never itself ran the registration command), and (2) escalates unread-parent
  messages to IMPERATIVE priority wording, backed by a Stop-gate that force-blocks until the
  durable inbox shows no unread backlog — with an optional STRICT fallback probe
  (`ANTIHALL_DEVSWARM_CHILD_GATE_STRICT`, default ON) that additionally checks a bounded,
  non-destructive `hivecontrol workspace message-count` when the durable check alone shows
  nothing. No Codex-side equivalent hook exists in this plugin.
- **Archive flow — agent-agnostic CLI, both roles.** anti-hall never archives mechanically.
  PARENT role: after verifying merged+tested+deployed **per your own repo's policy** (anti-hall
  does not check this), run `node scripts/devswarm.js archive-request <childId|childBranch>
  [--reason TEXT] [--child-branch B]` — SEND-ONLY, posts a `[[ANTIHALL_ARCHIVE_REQUEST]]`
  message via `hivecontrol workspace message-child`, never archives itself. CHILD role: on
  seeing that marker in an unread message, confirm with YOUR user, then run
  `node scripts/devswarm.js archive <id>`. Both verbs are the same agent-agnostic CLI as the
  rest of `scripts/devswarm.js` — invokable from a Codex session directly. (The CHILD side's
  automatic marker-detection/surfacing, above, is Claude-only; a Codex-side child would need
  its own equivalent check, e.g. `inbox read <id>` and a manual scan for the marker string.)

## #32 — retiring a competing native-queue consumer (applies to both agents)

If parent↔child messages seem to vanish or the durable inbox disagrees with what was actually
sent, the likely cause is a **second process** — outside anti-hall entirely — also calling
`hivecontrol workspace monitor`/`read-messages` against the same queue (a leftover cron job,
`launchd`/`systemd`/`pm2` unit, shell loop, or `package.json` script). This is agent-agnostic:
neither the Claude nor the Codex side of `command-guard.js` can see or block a process outside
its own tool-call surface. **anti-hall CANNOT mechanically detect or kill an external
non-tool-call consumer — identification + your own cleanup are the only levers.** Full
identify → stop → verify recipe: `docs/KB-devswarm-hivecontrol.md` §8.7.2 (`ps aux | grep
'hivecontrol.*monitor'` → kill the PID + remove its respawn config → re-run
`node hooks/doctor.js`).

## CLI reference — `scripts/devswarm.js`

The structured interface (CLI over MCP) is agent-agnostic — invokable identically from
a Codex or Claude session (`node "$ANTI_HALL_ROOT/scripts/devswarm.js" <cmd> ...`, with
`$ANTI_HALL_ROOT` resolved as shown below).
Subcommands: `register`/`ensure` (write a workspace descriptor), `register-primary`
(register the CURRENT worktree's Primary under its per-worktree id `primary-<hash>`),
`heartbeat`, `inbox pull`/`read`/`count`/`ack` (child-side durable-inbox cursor
primitives), `inbox messages`/`read-primary` (Primary/store non-destructive read — no
descriptor needed), `workspaces list`, `gate --set/--clear`, `nudge`, `archive`,
`archive-request` (PARENT-side, send-only — see above), `archive-ignore`/
`archive-unignore`, `migrate` (fold legacy on-disk state into the store; env
`ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1` marks an imported backlog as already-read — see
`scripts/migrate-state.js --mark-read`, the separate migration script, for the CLI-flag
form).

**Ack-ownership guard (v0.56.0).** `inbox messages --ack` / `inbox read-primary` refuse
(`ok:false`, cursor untouched) unless the caller's own identity matches `<id>` — identity
is derived from **cwd as ground truth**: a git worktree resolves to its own workspace id,
and a `DEVSWARM_BUILDER_ID` env value naming a *different* workspace is IGNORED (never
trusted to override), closing an env-spoof path where a workspace could impersonate
another workspace's identity to ack its cursor. Pass `--ack-as-owner` to override for a
legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's backlog on
its behalf).

Full table with source-line citations and a worked example:
`docs/KB-devswarm-hivecontrol.md` §8.8 (or the fuller quick
reference in `plugins/anti-hall/skills/devswarm/SKILL.md`).

## On-demand recovery — devswarm-recover CLI

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
node "$ANTI_HALL_ROOT/companion/devswarm-recover.js" <workspace-id>
```

This is **the only place in DevSwarm that ever kills a process** — the automatic sweep
above never does. It's Claude-side tooling (it identity-binds to and resumes a `claude`
process), but **a Codex-side operator in a mixed OMC/OMX DevSwarm setup can run it
directly** against a `claude` workspace's id — there's nothing Claude-only about invoking
the script itself, only about what it targets. Naming the id on the command line is a
deliberate override: unlike the automatic sweep, this CLI will also target an
**interactive** `claude` session (not just headless), under the same confirm-gate safety
(exactly-one-or-abstain, identity + cwd re-confirmed immediately before every signal,
single-writer lock, a recovery cap before it escalates instead). Windows: escalate-only,
never kills. Full detail (safety invariants, resume guardrail, env) lives in
`plugins/anti-hall/skills/devswarm/SKILL.md` (the Claude mirror of this skill).

## Activation (Claude-side; for awareness)

If you're the one wiring up a mixed OMC/OMX DevSwarm setup and need the automatic
supervisor active for the Claude side, the install command and full activation contract
(per-workspace descriptor at `~/.anti-hall/devswarm/workspaces/<id>.json` — `id`,
`worktreePath`, `sessionId` required; `inboxPath`/`cursorPath` load-bearing; optional
`nudgeCommand`/`escalateCommand` argv arrays for Layers 2–3; env gates
`DISABLE_ANTIHALL_DEVSWARM=1` / `ANTIHALL_DEVSWARM_SUPERVISOR`; the
`ANTIHALL_DEVSWARM_NUDGE_*` tuning vars) live in `plugins/anti-hall/skills/devswarm/SKILL.md`.
The `update` skill on the Claude side autonomously installs/refreshes this supervisor
whenever it detects it's running inside an active DevSwarm session — no separate step
needed once that side is set up. As of 0.54.1, the same autonomous-refresh posture also
covers `companion/install-devswarm-ingest.js` — the one supervised daemon wrapping
`hivecontrol workspace monitor` into the substrate store (`companion/devswarm-ingest.js`,
shipped 0.54.0). It runs continuously (macOS LaunchAgent `KeepAlive` / Linux `systemd
--user` `Restart=always` `.service`, cron fallback with a ~60s worst-case revive gap on a
cron-only Linux host), distinct label/log from the supervisor, and is Claude-side
tooling like the rest of this section — for awareness on a mixed OMC/OMX setup, not a
Codex-side capability. **Scope note (applies regardless of which agent is running in
which workspace):** the daemon is PER-PROJECT, not per-machine — its identity (label/
unit/lock/own reception workspace id) is derived from the worktree it was installed
FROM, since `hivecontrol` itself resolves a workspace by walking up from the process's
cwd, not by id. A mixed setup with multiple DevSwarm repos on one machine needs this
installer run once per repo; a repo with no install of its own has zero ingest coverage,
whether its workspaces run Claude or Codex agents. Full detail:
`docs/KB-devswarm-hivecontrol.md` §8.7.

Outputs to watch either way: `~/.anti-hall/devswarm/liveness/<id>.json` (per-workspace
verdict — `alive`/`stale`/`nudged`/`ambiguous`/`escalated`), `~/.anti-hall/devswarm/recovery.log`
(append-only attempt/poke/escalate log), and `node hooks/doctor.js` (silent unless
DevSwarm is active; `nudged` reports as WARN, not a failure).

## Anti-hall + OMX workflow mapping

- Workspace tier (unbuilt): would be CLI-identical between agents — `hivecontrol
  workspace create … -a codex` vs `… -a claude` — only the in-workspace fan-out differs
  (`omx team`/workers vs Workflow tool + subagents).
- Layered recovery model + on-demand CLI: Claude-only in what they target, as above. No
  Codex-side equivalent exists in this plugin, though the CLI is invokable from either side.

Anti-hall does not replace OMX. Anti-hall supplies verify-first policy, the reference KB,
and (for the Claude side) the layered recovery model; OMX supplies Codex-native
orchestration/workflow runtime.
