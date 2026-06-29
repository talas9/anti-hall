---
name: anti-hall-update
description: Check or update anti-hall from the local marketplace clone. Use when the user asks to update anti-hall, check whether anti-hall is current, or refresh the Codex port files.
---

# anti-hall update for Codex

Use the existing pure-Node update helper:

```bash
node plugins/anti-hall/skills/update/scripts/update.js --check
node plugins/anti-hall/skills/update/scripts/update.js
```

For Codex, also re-run the Codex hook installer after a successful update:

```bash
node plugins/anti-hall/codex/install-codex.js
```

or for global Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js --global
```

Do not force-pull, rebase, or delete plugin cache directories. If the update helper reports a dirty tree, diverged branch, offline state, or missing marketplace clone, surface that result and stop.

After updating, restart Codex or start a fresh session if plugin/skill discovery does not reflect the new files immediately.
