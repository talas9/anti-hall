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

## command-guard's destructive-read redirect (shipped, v0.53.0 — applies to Codex too)

Unlike the recovery model above, this one is **not** Claude-only: `command-guard.js` is
a single file registered in both `codex/hooks/hooks.json` and the Claude hooks.json, so
its DevSwarm branch fires identically for a Codex workspace. Under a DevSwarm-active
session it redirects the two CONSUMING native `hivecontrol` inbox reads, in ALL contexts
(a delegated read drains the queue identically): `hivecontrol workspace monitor` blocks
UNCONDITIONALLY (a no-timeout long-poll that hangs the shell and consumes the queue);
`hivecontrol workspace read-messages` blocks ONLY when durable-inbox evidence exists —
`ANTIHALL_DEVSWARM_INBOX_CMD` set, or a `~/.anti-hall/devswarm/workspaces/*.json`
descriptor with a truthy `inboxPath` — so a harmless single-consumer `read-messages` is
still allowed. Non-destructive `message-count`/`message-parent`/`message-child` are
untouched. Own `devswarm-read-guard` skip name (in skip-guard's `DESTRUCTIVE` set — a
blanket `all` skip does not cover it). Full detail: `docs/KB-devswarm-hivecontrol.md`
§8.5.

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
Codex-side capability.

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
