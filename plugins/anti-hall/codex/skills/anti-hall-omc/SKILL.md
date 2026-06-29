---
name: anti-hall-omc
description: Inspect or integrate optional oh-my-claudecode/OMC state with anti-hall in Codex. Use when the user asks whether OMC is installed for Codex or why anti-hall did not install OMC.
---

# anti-hall OMC integration for Codex

OMC is a recommended optional companion, not an anti-hall dependency.

Anti-hall uses OMC when present for:

- limit-conserve auto mode
- OMC autonomous-loop deference in task guards
- consolidated status/progress state where available

Check local OMC state:

```bash
find .omc ~/.omc -maxdepth 3 -type f 2>/dev/null | head -80
grep -RIn "oh-my-claudecode@omc\\|enabledPlugins" .omc ~/.codex ~/.agents 2>/dev/null | head -80
```

Check anti-hall's OMC helper:

```bash
node --check plugins/anti-hall/hooks/omc-detect.js
```

Do not install OMC automatically from anti-hall activation. It changes separate global/project state and should be explicit.

If the user explicitly asks to install OMC for Codex, first verify the current official install path from the OMC repository/docs, then install using that documented path. Do not infer a command from stale Claude plugin docs.
