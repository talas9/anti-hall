---
name: anti-hall-install-statusline
description: Explain and install anti-hall statusline support where available. Use when the user asks for the anti-hall statusline in Codex or wants OMC/anti-hall status visibility.
---

# anti-hall statusline for Codex

The existing anti-hall statusline installer targets Claude Code `statusLine` settings:

```bash
node plugins/anti-hall/statusline/install-statusline.js --help
```

Codex/OMX `[tui].status_line` uses documented built-in footer item IDs, not a command-backed renderer. Do **not** append an arbitrary `anti-hall-version` item unless Codex documents custom item support. For Codex, use these supported pieces:

- phase/progress state writer:

```bash
node plugins/anti-hall/statusline/phase.js
```

- statusline renderer smoke check:

```bash
node plugins/anti-hall/statusline/statusline.js
```

- OMX HUD/statusline built-ins through `omx hud` and `[tui].status_line`
- OMC-compatible consolidated state is still read by anti-hall helpers when present.

Do not write Claude `.claude/settings.json` when the user asked for Codex-only setup. If the user explicitly wants Claude statusline too, use the original Claude skill or script.
