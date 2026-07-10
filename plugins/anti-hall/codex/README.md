# anti-hall for Codex

This directory contains the Codex-native port layer. It does not modify the
Claude Code plugin files.

Install project-local Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js
```

Install global Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js --global
```

Dry-run:

```bash
node plugins/anti-hall/codex/install-codex.js --dry-run
```

## Parity Notes

Codex hooks are not a 1:1 Claude Code hook runtime. Current official Codex docs
list hook support for `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SubagentStart`, `SubagentStop`, and `Stop`, with `PreToolUse` matchers that can
include `Bash`, `apply_patch`/`Edit`/`Write`, and MCP tools.

This port currently hard-registers only the anti-hall hooks whose payload
contracts are live-aligned and regression-tested for Codex:

- `SessionStart`: full verify-first protocol, graphify session reminder, version alert, codex-availability probe
- `UserPromptSubmit`: rotating verify-first nudge, task tracker, limit-conserve nudge
- `PreToolUse`: shell command guards (`git-guard`, `command-guard`, `graphify-guard`, `merge-gate`)
- `Stop`: task guards, graphify reminder, speculation guard/judge

Documented-but-not-yet-adapted anti-hall hard-hook parity:

- edit-time `api-guard`: current implementation parses Claude-style `Write/Edit/MultiEdit` payloads; Codex `apply_patch` payload adapter + tests are still needed before claiming hard-block parity
- edit-time `ship-it-guard`: same payload-adapter requirement
- edit-time `edit-guard` (0.50.0): same payload-adapter requirement — it carries the identical `apply_patch` gap and is intentionally not registered in `codex/hooks/hooks.json` until a real Codex edit payload is captured
- subagent lifecycle hooks: Codex documents `SubagentStart`/`SubagentStop`, but anti-hall has not yet added Codex-specific payload tests
- `PreCompact`/`PostCompact`: Codex documents them; anti-hall has not yet mapped Claude compaction behavior to Codex payloads
- `TaskCreated`/`TaskCompleted` and Claude Workflow JS files: no direct Codex equivalent documented; use skills, native subagents, OMX, or scripts instead
- DevSwarm liveness supervisor (`companion/devswarm-supervisor.js`, 0.47.0): intentionally **Claude-only, no Codex mirror** — it recovers wedged *Claude Code* sessions specifically (targets `claude` processes, `claude --resume`, and `~/.claude/projects` transcripts). Like the Claude side it is OPT-IN and fully dormant unless DevSwarm is in use (`DEVSWARM_REPO_ID`). A Codex-side equivalent would be a separate future effort keyed to Codex's own session/transcript model.
- `hooks/fable-availability.js`: intentionally **Claude-only, no Codex mirror** — it probes `~/.claude.json` for a Claude Fable model entitlement to inform the Claude Reviewer-seat fallback, which is irrelevant to gpt-5.x Codex/OMX sessions. Like the DevSwarm supervisor, it has no Codex mirror by design. Fable routing is itself policy-disabled (see `MODEL-POLICY.md`), so there is no behavior to port.

Model routing for Codex uses Codex model tiers:

- planning, validation, debate: `gpt-5.5`
- implementation: `gpt-5.4`
- cheap mechanical work: `gpt-5.4-mini` (default) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model available on ChatGPT Pro only, not an effort setting of the flagship


## Ported Codex skills

The Codex port exposes first-pass equivalents for the anti-hall skill surface:

- `anti-hall-activate` — install/enable supported Codex hooks
- `anti-hall-root-cause` — root-cause debugging protocol
- `anti-hall-orchestration` — delegation/task discipline
- `anti-hall-deadly-loop` — Reviewer/Critic hardening loop with `gpt-5.5`
- `anti-hall-ship-it` — scaled plan/build/verify workflow (replaces the retired `anti-hall-feature-launch`)
- `anti-hall-context-conserve` — context/usage conservation and model routing
- `anti-hall-model-policy` — Codex model routing table
- `anti-hall-doctor`, `anti-hall-update`, `anti-hall-debt`, `anti-hall-simplify`, `anti-hall-flutter-debug`, `anti-hall-install-statusline`, `anti-hall-omx`, `anti-hall-omc`

Context conservation is also wired as a `UserPromptSubmit` hook via `limit-conserve-inject.js`.
Feature launch is intentionally a Codex/OMX planning protocol, not a GSD wrapper, because GSD was removed from active Codex config.

## Codex/OMX statusline

Claude Code supports command-backed `statusLine` renderers, so anti-hall can wrap
an existing statusline and append the `AH: Vx.y.z` chip. Codex/OMX currently
configures `[tui].status_line` as an ordered list of built-in item IDs only
(for example `model-with-reasoning`, `git-branch`, `context-remaining`,
`codex-version`, token counters, and limit counters). No supported custom item
ID or command-backed footer renderer is documented in the local Codex/OMX docs
used for this port.

Codex-safe behavior:

- anti-hall does **not** inject an unsupported `anti-hall-version` footer item
- `anti-hall-install-statusline` documents the supported Codex/OMX HUD path
- the Claude statusline installer remains unchanged for Claude Code
