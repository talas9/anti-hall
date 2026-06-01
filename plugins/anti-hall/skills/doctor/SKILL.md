---
name: doctor
description: Health-check anti-hall — confirm Node is found, every hook is present + syntax-valid, the guards actually fire (live behavioral self-tests on git-guard / command-guard / swarm-guard), and the statusline is installed. Use when the user asks "is anti-hall working / active / running", "check the hooks", "anti-hall doctor", "are the guards on", or after install/update to verify everything is live.
---

# Doctor

Answers the only question that matters for a guardrail plugin: **is it actually running,
and do the guards actually fire?** It checks presence AND behavior — not just that files
exist, but that the guards block what they should and allow what they should.

## What it reports
- **Environment:** Node version (and whether it's ≥ 18 — below that the hooks silently
  no-op), platform, plugin version.
- **Hooks:** every script registered in `hooks.json` is present and syntax-valid.
- **Guard behavior (live self-tests):** spawns the real guards with crafted payloads and
  asserts exit codes — git-guard blocks force-push + AI self-credit and allows `git status`;
  command-guard blocks heavy commands in the coordinator but ALLOWS them in a subagent
  (payload `agent_id`); swarm-guard allows a normal spawn under healthy memory.
- **Statusline:** whether a statusLine is installed and in which scope.
- A final verdict: `anti-hall ACTIVE — N checks passed`, or the list of failures.

## How to run

The doctor is a `node` script (the command-guard blocks heavy commands on the main
thread), so **delegate it to a subagent** and relay the report:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/doctor.js"
```

Add `--quiet` for just the one-line verdict. Exit code is non-zero if any critical check
fails, so it is scriptable in CI too.

After relaying the report, if anything failed: the most common fix is **Node missing/<18**
(install Node ≥ 18) or **no statusLine** (run the `install-statusline` skill, then restart).
