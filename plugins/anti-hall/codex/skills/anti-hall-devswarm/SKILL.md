---
name: anti-hall-devswarm
description: Explain anti-hall's optional DevSwarm integration from Codex — the hivecontrol reference KB, the (designed, unbuilt) workspace-tier orchestration, and the shipped liveness supervisor (Claude-side companion). Use when the user asks about DevSwarm, hivecontrol, or the anti-hall liveness supervisor while working in Codex.
---

# anti-hall DevSwarm integration (Codex view)

anti-hall's DevSwarm support is **optional and feature-detected**, same model as the
OMC/OMX integration: dormant, zero effect, unless DevSwarm is actually in use. anti-hall
ships only generic pieces; any DevSwarm-consumer glue (inbox daemon, done-report
contract, `hivecontrol` wiring) is the downstream project's, not this plugin's.

DevSwarm itself is **agent-agnostic** — `DEVSWARM_AI_AGENT` names the active in-workspace
agent (`claude`, `codex`, …), so a Codex session can be running inside a DevSwarm
workspace too. What follows is what a Codex user needs to know about the three addons.

## The three addons

| Addon | Status | Where |
|---|---|---|
| **hivecontrol reference KB** | Reference doc | `docs/KB-devswarm-hivecontrol.md` — the `hivecontrol` CLI surface, `.devswarm/config.json` schema, `DEVSWARM_*` env vars, and the parent/child async message-passing model. Includes a parallel OMC/OMX table for the workspace tier (§8.4 of the KB): the workspace-create/merge surface is CLI-identical either way; only the in-workspace fan-out engine differs (Workflow tool + subagents for Claude, `omx team`/workers for Codex). Repo-clone-only — does not ship with a plugin install. |
| **Workspace-tier orchestration** | **Designed, NOT built** | `docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md`. Nothing from this plan exists in the repo yet (no `devswarm-role.js`/`devswarm-guard.js`/`devswarm-children.js`) — do not describe it as active in either OMC or OMX. |
| **Liveness supervisor** | **Shipped — Claude-only** | `companion/devswarm-supervisor.js` + `install-devswarm-supervisor.js` + `companion/lib/{liveness,recovery,target-session,doctor-devswarm}.js` + `hooks/lib/devswarm-detect.js`. Recovers **wedged `claude` sessions specifically** (workaround for `claude-code#39755`) — it targets `claude -p --resume <uuid>` processes by argv, not Codex sessions. This section explains it for awareness; it is not a Codex-side capability. |

## The liveness supervisor, for Codex users

Why it exists: a `claude` session inside a DevSwarm child workspace can go **wedged** —
process alive, listener dead, no crash for a restarter to catch, no timeout event to
generate a new turn (`anthropics/claude-code#39755`, related `#28482`/`#33949`). If your
DevSwarm setup mixes Claude and Codex workspaces (`DEVSWARM_AI_AGENT` differs per
workspace), the supervisor only ever touches the `claude` ones — it identity-binds to a
`claude` process's argv session id and cwd, is headless-only (never an interactive
session), and abstains rather than guesses on any ambiguity. A Codex workspace is simply
outside its target surface; nothing here kills or resumes a Codex process.

If you're the one wiring up a mixed OMC/OMX DevSwarm setup and need the supervisor
active for the Claude side, the install command lives in
`plugins/anti-hall/skills/devswarm/SKILL.md` (the Claude mirror of this skill) — it's a
Claude-side companion script, run once per machine (not per-workspace) from that side.
That skill also has the full activation contract: the per-workspace descriptor at
`~/.anti-hall/devswarm/workspaces/<id>.json` (`id`, `worktreePath`, `sessionId` required;
`inboxPath`/`cursorPath` load-bearing — without them the workspace can never be nominated
stale), the env gates (`DISABLE_ANTIHALL_DEVSWARM=1`, `ANTIHALL_DEVSWARM_SUPERVISOR`), and
the currently-hardcoded thresholds (idle/cooldown/max-recoveries/grace/stuck — not yet
env-tunable; check `companion/lib/liveness.js` and `companion/lib/recovery.js` for the
live defaults before assuming an override exists).

Outputs to watch either way: `~/.anti-hall/devswarm/liveness/<id>.json` (per-workspace
verdict), `~/.anti-hall/devswarm/recovery.log` (append-only attempt log), and
`node hooks/doctor.js` (silent unless DevSwarm is active; reports PASS/WARN/FAIL per
workspace).

## Anti-hall + OMX workflow mapping

- Workspace tier (unbuilt): would be CLI-identical between agents — `hivecontrol
  workspace create … -a codex` vs `… -a claude` — only the in-workspace fan-out differs
  (`omx team`/workers vs Workflow tool + subagents).
- Liveness supervisor: Claude-only today, as above. No Codex-side equivalent exists in
  this plugin.

Anti-hall does not replace OMX. Anti-hall supplies verify-first policy, the reference KB,
and (for the Claude side) the liveness supervisor; OMX supplies Codex-native
orchestration/workflow runtime.
