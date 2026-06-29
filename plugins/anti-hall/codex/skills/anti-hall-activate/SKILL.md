---
name: anti-hall-activate
description: Idempotent Codex setup for anti-hall. Use when the user asks to activate anti-hall, set it up for Codex, or install the Codex hooks.
---

# anti-hall activate for Codex

Activation for Codex installs the supported Codex hook subset and writes an advisory sentinel. It does not touch Claude Code settings.

1. Install project-local Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js
```

2. For global Codex hooks instead:

```bash
node plugins/anti-hall/codex/install-codex.js --global
```

3. Verify:

```bash
node plugins/anti-hall/hooks/doctor.js
codex features list
test -f .codex/hooks.json && sed -n '1,220p' .codex/hooks.json
```

4. Write sentinel:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const d=path.join(os.homedir(),'.anti-hall');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'codex-activated.json'),JSON.stringify({activatedAt:new Date().toISOString(),scope:process.cwd()},null,2)+'\n')"
```

Codex limitations after activation:

- shell guards are hard hooks
- session/prompt/stop nudges are hooks
- edit-time `api-guard` and `ship-it-guard` are not hard hooks in Codex today
- subagent lifecycle hooks are not available in Codex today

Use `anti-hall-doctor` to inspect the active state.
