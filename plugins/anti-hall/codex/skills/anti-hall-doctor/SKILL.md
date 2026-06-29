---
name: anti-hall-doctor
description: Check anti-hall's Codex installation and runtime posture. Use when the user asks whether anti-hall is active in Codex, whether hooks are installed, or why a guard did or did not fire.
---

# anti-hall doctor for Codex

Run the existing doctor first:

```bash
node plugins/anti-hall/hooks/doctor.js
```

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
node plugins/anti-hall/codex/install-codex.js
```

For global install:

```bash
node plugins/anti-hall/codex/install-codex.js --global
```
