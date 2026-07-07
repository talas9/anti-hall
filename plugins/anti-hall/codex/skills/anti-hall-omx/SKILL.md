---
name: anti-hall-omx
description: Integrate anti-hall with oh-my-codex (OMX). Use when the user asks about OMX, omx setup/doctor, Codex workflows, cx.sh, dangerous bypass launch, or activating anti-hall workflows through OMX.
---

# anti-hall OMX integration

OMX is the Codex workflow/orchestration companion. OMC is Claude-focused; for Codex use OMX.

## Verify OMX

```bash
omx --version
omx doctor
```

Expected active surfaces after `omx setup --plugin --scope user --with-mcp --merge-agents`:

- Codex plugin hooks enabled
- role agents installed under `~/.codex/agents/`
- OMX skills available under the oh-my-codex plugin cache
- optional first-party OMX MCP servers configured in `~/.codex/config.toml`

## Launch wrapper

A dangerous-bypass local launcher can be:

```bash
#!/bin/bash
omx --madmax "$@"
```

Resume last run:

```bash
./cx.sh resume --last
```

## Anti-hall + OMX workflow mapping

- Ship-it (replaces the retired feature-launch): `anti-hall-ship-it` plus OMX `$plan`, `$ralplan`, `$team`, `$ralph`, or `$ultragoal` as the execution surface when task size justifies it.
- Deadly-loop: `anti-hall-deadly-loop`; debate roles stay on `gpt-5.5`.
- Context conservation: `anti-hall-context-conserve`; route lookup/mechanical work to spark/mini lanes.

Anti-hall does not replace OMX. Anti-hall supplies verify-first policy and guards; OMX supplies Codex-native orchestration/workflow runtime.
