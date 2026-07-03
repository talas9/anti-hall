---
name: anti-hall-simplify
description: Behavior-preserving simplification workflow for Codex. Use when the user asks to simplify, deslop, trim fat, or reduce over-engineering.
---

# anti-hall simplify for Codex

Scope the simplification to the named files or current diff. Do not sweep the whole repo unless explicitly asked.

Workflow:

1. Establish a green baseline by running the relevant check.
2. List simplification findings using tags:
   - `delete:` dead or unreachable code
   - `stdlib:` hand-rolled standard library behavior
   - `native:` language builtin/idiom replacement
   - `yagni:` speculative abstraction with no current caller
   - `shrink:` verbose equivalent that can be clearer shorter
   - `slop:` redundant comments, ceremony, impossible defensive checks
3. Apply only behavior-preserving edits.
4. Re-run the same check.
5. Report measured `net: -N lines` from actual diff output, never projected savings.

Model routing:

- audit/selection: `gpt-5.5` when ambiguous or risky
- implementation: `gpt-5.4`
- simple mechanical cleanup: `gpt-5.4-mini` (default) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only

If behavior would change, decline that finding and say why.
