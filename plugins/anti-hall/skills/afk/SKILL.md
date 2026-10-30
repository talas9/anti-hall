---
name: afk
description: AFK mode - agents work silently and log a milestone digest while you are away. Use for "afk", "I'm away", "back", "progress", "afk status", "turn off afk / idle detection".
---

# AFK mode

## When to use

The owner says they are stepping away ("afk", "going away", "brb"), comes back ("back", "what happened"), asks for the
digest ("progress"), or wants AFK settings changed.

## Commands

| What | Typed prompt | Command line |
|---|---|---|
| Start AFK (machine-wide, every session) | `afk` | `ah-engine afk on` |
| End AFK and print the digest | `back` | `ah-engine back` |
| Print the digest, stay AFK | `progress` | - |
| Show the state | - | `ah-engine afk status` |
| End AFK without a digest | - | `ah-engine afk off` |

A typed `afk` / `back` / `progress` prompt (the whole prompt, any case, surrounding spaces ignored) is answered by the hook and
not sent to the model. `ah-engine back` is the always-available escape: it works from any terminal, even when a typed `back`
is not recognised (quoted, or inside a longer prompt). A typed `back` that finds the flag busy says so and the flag stays ON;
`ah-engine afk` / `back` wait longer for the flag lock (`afk.cli_lock_wait_ms`), and only if it stays busy that long do they
exit non-zero, changing nothing: run them again.
Every flag write is fenced (`afk.fence_infix`): a hook stalled past `afk.lock_stale_ms` whose lock was taken over never
lands its stale write after a newer `back`. Latency caveat: hook calls of one engine daemon queue on an in-process mutex
before their lock budget starts, so a typed `afk` / `back` behind another hook of the same daemon can take longer.
AFK also starts by itself after `afk.idleMinutes` without an owner prompt on this machine; that idle AFK ends on the owner's
next prompt. A manual AFK lasts until `back`.

## What changes while AFK

- Each session gets the AFK rule once: no narration between tool calls, no status prose, decide instead of asking (never
  anything destructive), at most one line at the end of a turn, one checklist bullet per milestone in its progress file
  `.anti-hall/progress/<date>/<session>.md` (`- [x] done ...` / `- [ ] open ...`). A short reminder repeats in long turns.
- The digest (NEEDS OWNER bullets first) is the bullets after the session's AFK marker; the percentage is `[x]` bullets / all checklist bullets.
- No blocking questions: `AskUserQuestion` is denied EVERY time with the ladder below, and a turn that ends on a plain-text
  question is held at Stop with the ladder (at most `afk.question_max_holds` times).
- Subagents never get the AFK rule; their question-tool calls are denied too.
- Question ladder: decide from the plan and context; ask the advisor; only if still unclear AND not implied by the plan AND the
  choice is destructive/irreversible or would wreck the work if made the other way: park that ONE item as
  `- [ ] NEEDS OWNER: <question>` in the progress file and continue the other parts of the plan (very rare).
- A final reply over `afk.max_reply_chars` / `afk.max_reply_lines` is nudged once, then held at most `afk.max_blocks` times
  (never in a loop). All other guards are unchanged.

## Settings (`ah-engine settings set <key> <value>`)

| Key | Default | Effect |
|---|---|---|
| `afk.enabled` | true | Master switch for the whole feature |
| `afk.idleDetect` | true | Idle detection |
| `afk.idleMinutes` | 20 | Minutes without an owner prompt before idle AFK |
| `afk.promptCommands` | true | Typed `afk` / `back` / `progress` |
| `afk.enforce` | true | Nudge and capped hold of overlong AFK replies |
| `afk.measure` | true | Output tokens per turn, AFK vs present |
| `afk.conciseCodex` | true | Concise reply rule at Codex session start |
| `afk.noQuestions` | true | Deny the question tool and hold a turn ending on a question, while AFK |

Texts, limits and patterns: `engine/defaults/afk.toml`.

## Telemetry

`ah-engine metrics` shows `afk_entered{how}`, `afk_turns`, `digest_entries`, `idle_trips`, `afk_overlong_turns{action}`,
`afk_output_tokens{mode}`, `afk_turns_measured{mode}` (tokens / turns = output tokens per turn, AFK vs present),
`afk_question_denied{tool}` and `afk_question_parked{action}` (nudged, capped, listed).

## Plan auto-approve

Claude only (`afk.planAutoApprove`, default on, effective only while AFK): a plan exit (`ExitPlanMode`) is approved by the hook
when the main thread called the advisor after its last plan write and the last owner prompt (ordered by sequence, not clock), the
plan file still has the consulted content, and AFK is still on in the same period when re-checked. It fails closed: a clock
rollback, a state read/write error, a changed plan or an AFK switch leaves the normal approval prompt. Counters:
`afk_plan_autoapproved`, `afk_plan_autoapprove_denied{reason}`, `afk_plan_stamp_failed{field}`.

## Concise style

The plugin ships the output style `concise` (lead with the answer, 1-3 lines, no recap, no narration). It is forced while the
plugin is enabled (`force-for-plugin`), so it has no runtime switch; Codex gets the same rule at session start
(`afk.conciseCodex`).
