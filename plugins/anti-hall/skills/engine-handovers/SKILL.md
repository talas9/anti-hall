---
name: engine-handovers
description: "Use when writing or resuming a handover, or compacting context, and a handover or compaction guard applies."
---

# Handovers and compaction

Handover, resume and compaction guards.

## Guards

- `compact-declaration-guard`: Allows new work unless the current turn may hold a SAFE TO COMPACT declaration; a possible declaration defers to the Node guard, which...
- `auto-handover`: UserPromptSubmit: the threshold fire, the soft advisory, the milestone nag, the latch re-arm and the post-handover gate with its...
- `auto-handover-pause-nag`: Stop: the Stop-side fire with the decisive good-point line, the pause nag (step, quiet window, open tasks, recent spawns, handover...
- `compact-advice-guard`: Stop: blocks, once per declaration, a final reply that recommends compacting at low context or just after a compact (phrase analysis,...
- `progress-prune`: SessionStart maintenance: archives stale per-session progress files into the history ledger before removing them, and reminds weekly to...
- `precompact-snapshot`: PreCompact: writes a mechanical continuation snapshot (git state, task list, last user messages) before compaction and never blocks it...
- `handover-resume`: SessionStart: points a fresh or compacted session at the newest handover with git facts measured now (port of handover-resume.js)

## Switches

- `guards.compactDeclarationGuard` = true: Where the on/off switch is read from (guards.compactDeclarationGuard, default on; it has no environment variable)
- `autoHandover.decisivePrompt` = true: The autoHandover.decisivePrompt setting: the decisive good-point line at a Stop once the handover exists
- `autoHandover.enabled` = true: The autoHandover.enabled setting: write an automatic handover before the context runs out
- `autoHandover.gateNewWork` = true: The autoHandover.gateNewWork setting: the post-handover new-work gate
- `autoHandover.gateBudgetPct` = 5: The autoHandover.gateBudgetPct setting: the context points a request may use after the handover, and the backstop step
- `autoHandover.gateHousekeepingMarkers` = "": The autoHandover.gateHousekeepingMarkers setting: extra comma-separated housekeeping prompt markers (a text)
- `autoHandover.maxTokens` = 0: The autoHandover.maxTokens setting: an absolute token ceiling that also triggers the handover (0 means none)
- `autoHandover.nag` = true: The autoHandover.nag setting: remind when a handover is due
- `autoHandover.nagQuietMin` = 15: The autoHandover.nagQuietMin setting: the minutes between two nags at a quiet pause
- `autoHandover.nagStepPct` = 5: The autoHandover.nagStepPct setting: the context points between two nags
- `autoHandover.pct` = 85: The autoHandover.pct setting: the context percent that triggers the handover
- `guards.compactAdviceMarginPct` = 10: The guards.compactAdviceMarginPct setting: context points below autoHandover.pct at which a /compact recommendation counts as low-context
- `guards.compactAdviceRecentTurns` = 10: The guards.compactAdviceRecentTurns setting: a compact boundary within this many turns makes a /compact recommendation a block (0: off)
- `guards.compactAdviceGuard` = true: The guards.compactAdviceGuard setting: block a /compact recommendation made at low context or just after a compact
- `maintenance.progressPrune` = true: Switch: archive stale per-session progress files into the history ledger (maintenance.progressPrune); it has no environment variable
- `maintenance.precompactSnapshot` = true: Where the PreCompact snapshot switch is read from (maintenance.precompactSnapshot, default on)
- `context.handoverResume` = true: Where the handover resume switch is read from (context.handoverResume, default on)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
