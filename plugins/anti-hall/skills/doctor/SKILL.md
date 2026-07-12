---
name: doctor
description: Health-check AND repair anti-hall — confirm Node is found, every hook is present + syntax-valid, the guards actually fire (live behavioral self-tests on git-guard / command-guard / edit-guard / swarm-guard / model-routing-guard), the statusline is installed, and (in repair mode) auto-apply safe fixes. Use when the user asks "is anti-hall working / active / running", "check the hooks", "anti-hall doctor", "repair anti-hall", "fix the daemon", "are the guards on", or after install/update to verify everything is live.
---

# Doctor

Answers the only question that matters for a guardrail plugin: **is it actually running,
and do the guards actually fire?** It checks presence AND behavior — not just that files
exist, but that the guards block what they should and allow what they should. As of
v0.55.0 it also **repairs**: plain `doctor` diagnoses everything AND auto-applies the safe
fixes (see [Repair mode](#repair-mode) below).

## What it reports
- **Environment:** Node version (and whether it's ≥ 18 — below that the hooks silently
  no-op), platform, plugin version.
- **Hooks:** every script registered in `hooks.json` is present and syntax-valid.
- **Guard behavior (live self-tests):** spawns the real guards with crafted payloads and
  asserts exit codes — git-guard blocks force-push + AI self-credit and allows `git status`;
  command-guard blocks heavy commands in the coordinator but ALLOWS them in a subagent
  (payload `agent_id`); edit-guard blocks a coordinator Edit but ALLOWS the same Edit in
  a subagent (payload `agent_id`/`agent_type`), sharing that coordinator-vs-subagent
  discriminator with command-guard via `coordinator-detect.js`; swarm-guard allows a
  normal spawn under healthy memory; model-routing-guard blocks a mechanical task pinned
  to a flagship model (synthetic payload: fetch/download description + `model:"opus"` +
  `subagent_type:"general-purpose"` → exit 2) and allows a benign spawn with no model and
  no mechanical signals (exit 0); omc-detect.js (the OMC-deference shared helper consumed
  by task-guard / tasklist-guard) is checked for presence + syntax validity.
- **Statusline:** whether a statusLine is installed and in which scope.
- **DevSwarm RUNTIME health** (when the DevSwarm gate is active — same gate as the
  liveness supervisor section): store/journal health (sqlite `quick_check` via an
  isolated `--no-warnings` read-only probe, journal torn-line scan, store↔summary
  parity), data staleness (summary.json age, gated on the daemon actually running
  AND a workspace having unread backlog — an idle system never false-alarms),
  daemons **RUNNING** vs merely installed (per-worktree ingest + the supervisor —
  distinguishes installed-but-DEAD from not-installed), and a no-other-consumer scan
  (a second native `hivecontrol workspace monitor` process would split the
  destructive queue — report-only, never killed). See [Runtime health
  checks](#runtime-health-checks) below.
- **Foreign skill/hook conflict scan** (always runs, independent of DevSwarm):
  cross-references other ENABLED plugins' `hooks.json`/skills against anti-hall's
  own. See [below](#foreign-skillhook-conflict-scan).
- A final verdict: `anti-hall ACTIVE — N checks passed`, or the list of failures.

## Runtime health checks

Wired into the existing "DevSwarm liveness supervisor" section (same gate:
`isDevswarmActive(env)` or a published workspace descriptor), implemented in
`companion/lib/doctor-runtime.js`. All four are **report-only** — none of them
restart, reinstall, or kill anything (that stays doctor-repair.js's job, still
gated the same way):

1. **DB/store health** — ENUMERATES every PER-PROJECT store (`store/<hash>/devswarm.db`,
   plus a legacy flat `store/devswarm.db` if a pre-migration one is present) and, for
   each, opens a SEPARATE **read-only** `node:sqlite` handle and runs `PRAGMA
   quick_check`. WAL means this can never
   block the ingest daemon (its single-consumer lock is a distinct O_EXCL
   lockfile, not a DB lock). The `require('node:sqlite')` call happens **only**
   inside a `--no-warnings` child probe, so its ExperimentalWarning never reaches
   doctor's own stderr. The journal backend gets a torn-line scan (a torn line
   followed by more valid content is real corruption; a torn *trailing* line is a
   normal in-flight write and is never flagged). Store↔summary parity flags
   **only** `summary.total > store.total` (a store ahead of a not-yet-derived
   summary is normal and never flagged).
2. **Data staleness** — flags a stale `summary.json` only when the daemon is
   confirmed RUNNING (check 3) *and* a workspace has `unread > 0`; prefers the
   ingest daemon's own per-worktree heartbeat (`heartbeats/ingest-<hash>.json`,
   rewritten every sweep) over the blunter `generatedAt`, which only advances on
   an actual insert.
3. **Daemons RUNNING, not just installed** — per-worktree ingest units (via
   `listInstalledIngestUnits`) and the supervisor: `launchctl list` / `systemctl
   --user is-active` / (cron fallback) heartbeat-or-`ps`. Distinguishes
   installed-but-DEAD (WARN) from not-installed (INFO, not a warning).
4. **No other consumer** — reads the per-worktree ingest lock(s) and cross-checks
   against a `ps` scan for `hivecontrol workspace monitor` processes; more than
   one, or one holding no lock, is a high-severity WARN (report-only — the
   single-consumer invariant is never enforced by killing anything here).

## Foreign skill/hook conflict scan

Its own **unconditional** top-level section (`companion/lib/doctor-runtime.js`'s
`scanForeignConflicts`) — runs regardless of DevSwarm state. Cross-references
every OTHER **enabled** plugin's `hooks.json` (found via
`~/.claude/plugins/installed_plugins.json`, the harness-owned install index) and
skill directory names against anti-hall's own. A foreign `PreToolUse` hook on
Bash or a second `Stop` hook is surfaced (WARN — third-party plugin config is
never a reason to fail anti-hall's own exit code); additive `UserPromptSubmit`/
`SessionStart` overlap is INFO (non-competing); a skill-name collision is WARN.
**Privacy:** only the plugin name, event, matcher, and hook script **basename**
are ever reported — never a full command string (which can carry a local
username/path) or file contents.

## Repair mode

Plain `doctor` now runs the full diagnosis AND then a **repair pass** that fixes what it
safely can. It writes files/units, so the same Haiku-delegation rule applies (below).

Flags:

| Invocation | Behavior |
|---|---|
| `node hooks/doctor.js` (no flags) | FULL detection + auto-apply AUTO-SAFE fixes + GATED daemon fixes only when the DevSwarm gate is open. This is the default. |
| `--fix` / `--repair` | Explicit aliases for the default auto-apply path (discoverability). |
| `--dry-run` | Detection + print exactly what WOULD be fixed. **Writes nothing** (threads each installer's own `--dry-run`, migrate-state `dryRun:true`). |
| `--check` | **PURE read-only** — detects + reports everything, mutates NOTHING. The CI / scripting path. |
| `--quiet` | One-line verdict only (combines with any of the above). |

**Two safety classes:**

- **AUTO-SAFE** (always applied, honors `--dry-run`): legacy/GSD/DevSwarm-store state
  migration; statusline install **only when NO statusLine is configured in any scope** (a
  custom statusLine is never overridden); idempotent relaunch of an ALREADY-installed
  supervisor; refresh of Codex hooks when a `.codex/config.toml` exists but the hooks are
  unwired (it never creates a new `.codex`).
- **GATED** — applied only when the **DevSwarm gate** is open: `isDevswarmActive(env)` (a
  DevSwarm-active session) **AND** `resolveWorktree(cwd)` is a real git worktree. Covers
  the ingest daemon install, the **v0.54.1 wrong-path ingest heal** (a unit whose
  `WorkingDirectory` no longer points inside a worktree is rebuilt from the right one),
  stale ExecStart script, and the supervisor FIRST-install. When the gate is closed, doctor
  **reports the gap plus the exact manual command** and mutates nothing.
- **REPORT-ONLY:** the MCP orphan reaper is never auto-installed (it kills orphans on a
  timer) — doctor only prints how to enable it.

After each fix, doctor **re-runs the relevant detection** to confirm it actually took
before reporting `FIXED` (a spawned installer's exit code is not trusted — `launchctl load`
can warn). A `FAILED` repair keeps the exit code non-zero.

**Complementarity with `update` (SKILL step 7):** both `doctor` and the `update` skill call
the same idempotent installers under the same DevSwarm gate, so running both is harmless —
a double-refresh is a no-op. `update` refreshes on version change; `doctor` repairs on
demand.

Windows: the daemon fixes (ingest / supervisor) are documented no-ops (no built-in
user-level scheduler / no safe cwd confirm-gate).

## How to run

The doctor is a `node` script that now **writes units/settings** in repair mode (and the
command-guard blocks heavy commands on the main thread), so **delegate it to a Haiku
subagent** (`model:"haiku"` — an execution-shaped spawn with no explicit model also trips
model-routing-guard's strict-mode block) and relay the report:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/doctor.js"           # diagnose + repair (default)
node "${CLAUDE_PLUGIN_ROOT}/hooks/doctor.js" --dry-run # show what it would fix
node "${CLAUDE_PLUGIN_ROOT}/hooks/doctor.js" --check   # pure read-only (CI)
```

Add `--quiet` for just the one-line verdict. Exit code is non-zero if any critical check
(or repair) fails, so it is scriptable in CI too — use `--check` there to keep it read-only.

After relaying the report, if anything failed: the most common fix is **Node missing/<18**
(install Node ≥ 18) or **no statusLine** (repair mode installs it automatically, or run the
`install-statusline` skill, then restart).
