---
name: anti-hall-afk
description: AFK mode - agents work silently and log a milestone digest while you are away. Use for "afk", "I'm away", "back", "progress", "afk status", "turn off afk / idle detection".
---

# AFK mode (Codex)

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

A typed `afk` / `back` / `progress` prompt (alone on the line) is answered by the hook and not sent to the model.
AFK also starts by itself after `afk.idleMinutes` without an owner prompt on this machine; that idle AFK ends on the owner's
next prompt. A manual AFK lasts until `back`.

## What changes while AFK

- Each session gets the AFK rule once: no narration between tool calls, no status prose, decide instead of asking (never
  anything destructive), at most one line at the end of a turn, one checklist bullet per milestone in its progress file
  `.anti-hall/progress/<date>/<session>.md` (`- [x] done ...` / `- [ ] open ...`). A short reminder repeats in long turns.
- The digest (NEEDS OWNER bullets first) is the bullets after the session's AFK marker; the percentage is `[x]` bullets / all checklist bullets.
- No blocking questions: Codex has no hookable question tool, so the ladder is carried by the AFK rule, and a turn that ends
  on a plain-text question is held at Stop with the ladder (at most `afk.question_max_holds` times).
- Question ladder: decide from the plan and context; ask the advisor; only if still unclear AND not implied by the plan AND the
  choice is destructive/irreversible or would wreck the work if made the other way: park that ONE item as
  `- [ ] NEEDS OWNER: <question>` in the progress file and continue the other parts of the plan (very rare).
- Codex: the reply-length hold is not applied (the Stop check reads Claude transcripts only); the question hold, rule,
  reminders, digest and prompt commands are. All other guards are unchanged.

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
| `afk.planAutoApprove` | true | Approve ExitPlanMode after an advisor review, while AFK (Claude) |

Texts, limits and patterns: `engine/defaults/afk.toml`.

## Telemetry

`ah-engine metrics` shows `afk_entered{how}`, `afk_turns`, `digest_entries`, `idle_trips`, `afk_overlong_turns{action}`,
`afk_output_tokens{mode}`, `afk_turns_measured{mode}` (tokens / turns = output tokens per turn, AFK vs present),
`afk_question_denied{tool}`, `afk_question_parked{action}` (nudged, capped, listed) and `afk_plan_autoapproved{result}`.

## Concise style

Codex has no output styles: the concise reply rule (lead with the answer, 1-3 lines, no recap, no narration) is injected at
session start while `afk.conciseCodex` is on.
