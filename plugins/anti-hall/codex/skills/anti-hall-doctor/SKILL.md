---
name: anti-hall-doctor
description: Check anti-hall's Codex installation and runtime posture. Use when the user asks whether anti-hall is active in Codex, whether hooks are installed, or why a guard did or did not fire.
---

# anti-hall doctor for Codex

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — that
variable is only set for plugin-bundled hook commands (see
`docs/KB-codex-platform-hooks-plugins.md`). Codex does show you this skill's own
file path when it selects the skill ("Codex starts with each skill's name,
description, and file path" — official Codex Skills doc). Resolve the plugin
root from that path before running anything below:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

Run the existing doctor first. `doctor.js` is the SHARED script (Codex wires the same
hooks via `install-codex.js`), so its repair mode (v0.55.0) applies identically here:

```bash
node "$ANTI_HALL_ROOT/hooks/doctor.js"           # diagnose + repair (default, auto-applies safe fixes)
node "$ANTI_HALL_ROOT/hooks/doctor.js" --dry-run # print what it would fix; writes nothing
node "$ANTI_HALL_ROOT/hooks/doctor.js" --check   # PURE read-only (mutates nothing) — the CI/scripting path
```

Repair flags (mirror the Claude `doctor` skill): plain / `--fix` / `--repair` auto-apply;
`--dry-run` shows would-fix and writes nothing; `--check` is read-only; `--quiet` is the
one-line verdict. Two classes: **AUTO-SAFE** (state migrations; statusline only when none
is configured; idempotent supervisor relaunch; **Codex hook refresh when a
`.codex/config.toml` exists but the hooks are unwired** — it never creates a new `.codex`)
and **GATED** daemon fixes (ingest install / wrong-path rebind / stale-script / supervisor
first-install) applied only when `isDevswarmActive(env)` AND `resolveWorktree(cwd)` is a git
worktree — otherwise doctor reports the exact manual command. The **DevSwarm gate is
effectively always closed for gpt-5.x Codex/OMX sessions** (the `DEVSWARM_*` env vars are
set only for the `claude` child sessions hivecontrol spawns), so on Codex the daemon fixes
report the manual command rather than acting — matching the liveness supervisor's
Claude-only status. Windows daemon fixes are documented no-ops.

`doctor.js` also carries the same DevSwarm **RUNTIME health checks** as the Claude side
(`companion/lib/doctor-runtime.js`, same shared script): store/journal health across
every PER-PROJECT store `store/<hash>/` (sqlite `quick_check` via an isolated
`--no-warnings` read-only probe, journal torn-line scan, store↔summary parity),
data staleness (gated on the daemon RUNNING + unread backlog —
never flags an idle system), daemons RUNNING vs merely installed (report-only, never
restarts), and a no-other-consumer scan for a stray `hivecontrol workspace monitor`
process (report-only, never kills). Since the DevSwarm gate is effectively always closed
on Codex sessions, these four checks are effectively always silent there too (correct —
DevSwarm liveness is a Claude-child-session concern). Separately, an **unconditional**
foreign skill/hook conflict scan runs regardless of DevSwarm state, cross-referencing
other enabled plugins' `hooks.json`/skills against anti-hall's own; only plugin name +
event + matcher + hook basename are ever reported (never full command strings or file
contents).

Then verify Codex-specific surfaces:

```bash
codex features list
test -f .codex/hooks.json && sed -n '1,220p' .codex/hooks.json
test -f ~/.codex/config.toml && grep -n "hooks\\|codex_hooks" ~/.codex/config.toml
```

Interpretation:

- `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop` anti-hall entries in `.codex/hooks.json` mean the Codex hook subset is installed.
- `[features].hooks = true` in Codex config means the current Codex runtime should load hooks.
- Missing edit-time `api-guard` / `ship-it-guard` hard blocks are expected in Codex; current Codex hook runtime does not provide Claude-equivalent `PreToolUse` for edits.
- Missing subagent lifecycle hooks are expected; Codex has no direct `SubagentStart` / `TaskCreated` / `TaskCompleted` equivalents.

If hooks are missing, install them:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js"
```

For global install:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js" --global
```
