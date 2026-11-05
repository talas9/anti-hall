---
name: engine-replies
description: "Use when a Stop hold says the reply is too long, or you need to tune or switch off the reply-length guard."
---

# Reply length

The final-reply length guard (R-style) and its limits.

## Guards

- `reply-length-guard`: Stop (Claude and Codex): with guards.styleRule on, holds a final reply over guards.replyMaxChars...

## Switches

- `guards.styleRule` = false: Switch guards.styleRule (default off, plan v2 D14)
- `guards.replyMaxChars` = 1200: Setting guards.replyMaxChars: the most visible characters of a final reply before it is held...
- `guards.replyMaxLines` = 18: Setting guards.replyMaxLines: the most non-blank visible lines of a final reply before it is...

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
