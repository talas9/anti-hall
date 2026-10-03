---
name: anti-hall-model-policy
description: Codex model routing policy for anti-hall work. Use when selecting models for planning, implementation, review, debate, or mechanical execution in Codex.
---

# anti-hall Codex model policy

**Never pin a model version.** Codex generations get renamed and retired
without notice (verified 2026-09-23: `gpt-5.4-mini`, `gpt-5.4`,
`gpt-5.3-codex`, and `gpt-5.3-codex-spark` are all absent from the live
catalog and return `400 ... not supported`). Route by CATEGORY, resolved from
the CLI's own live model catalog at the time you act — never from a slug
memorized in this file or any other doc.

## How to resolve a category to a model

1. Run `codex debug models` (or read the cache it writes to
   `~/.codex/models_cache.json` — same data, no spawn) to get the current
   model list.
2. Pick the category:
   - **frontier** — most capable model, for correctness review, security-
     sensitive validation, launch go/no-go, hard reasoning, debate roles.
   - **workhorse** — general coding/implementation from a settled plan.
   - **fast** — cheap/quick work: mechanical command running, repetitive
     execution, simple lookups.
3. Within models visible to you (skip anything hidden/internal), match the
   category using the catalog's own description text (e.g. "frontier
   intelligence", "workhorse model for coding", "fast and
   affordable/efficient") and prefer the NEWEST generation present — the
   catalog orders this for you (lower `priority` = newer). Skip a model the
   catalog flags as retiring/upgrading if a live alternative exists in the
   same category.
4. If you cannot resolve a category with confidence (catalog unreadable,
   nothing matches), **omit `-m` entirely** and let the CLI use its own
   configured default model. Do not guess a slug and do not fall back to a
   name from memory.

A Claude-side caller doing this programmatically (workflow scripts, hooks)
uses `plugins/anti-hall/companion/lib/codex-models.js`'s
`resolveCodexModel(category)` — it implements exactly the steps above,
spawn-free, and returns `null` on any failure so the caller omits `-m`.

Illustrative example only (STALE THE DAY YOU READ THIS — re-resolve, don't
copy): as of 2026-09-23 the live catalog's newest generation maps frontier →
`gpt-6-astra`, workhorse → `gpt-6-sol`, fast → `gpt-6-luna`. Do not hardcode
these slugs anywhere; they are shown only to make the category descriptions
concrete.

## Rules

- Debate roles always use the **frontier** category.
- Do not use the **fast** category for security-sensitive validation or
  launch go/no-go decisions.
- Do not run every subtask on **frontier** — distribute by task shape
  (frontier for review/debate, workhorse for implementation, fast for
  mechanical work).
- If a resolved model is unavailable or rate-limited, record the limitation
  and re-resolve for the nearest safe category. Do not silently downgrade
  debate below **frontier**.

## Claude-side mapping (when coordinating with Claude agents)

When this skill coordinates with anti-hall deadly-loop or ship-it, the
Claude-side tier token `sonnet` resolves to **the latest Sonnet** at runtime.
Claude-side role assignments:

- Reviewer (deadly-loop/ship-it): `model:"fable"` (Fable) when available, else `model:"sonnet"` = Sonnet, effort `xhigh`
- Planning secondary / medium scope: `model:"sonnet"` = Sonnet, effort `xhigh`
- Implementation failover (when Codex unavailable): `model:"sonnet"` = Sonnet, effort `high`
- Main coordinator, planning top-level, deep debug: `model:"opus"` = Opus

Cross-model rule: if Codex implements, Claude (Sonnet or Opus) reviews. If Sonnet implements, Codex or Opus reviews. No agent reviews its own implementation.

**Never pin a model version.** Route by tier token (`opus`/`sonnet`/`haiku`/`fable`) on the Claude side, and by CATEGORY (`frontier`/`workhorse`/`fast`) resolved from the live catalog on the Codex side — the harness/resolver picks the newest match each time. A version number written into a policy, prompt, or workflow goes stale the day a new model ships.
