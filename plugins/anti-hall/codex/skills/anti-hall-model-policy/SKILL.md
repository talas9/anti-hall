---
name: anti-hall-model-policy
description: Codex model routing policy for anti-hall work. Use when selecting models for planning, implementation, review, debate, or mechanical execution in Codex.
---

# anti-hall Codex model policy

| Task shape | Codex model | Effort |
| --- | --- | --- |
| Planning, architecture, validation, sensitive review, debate | `gpt-5.6-sol` | `xhigh` |
| Implementation from a settled plan | `gpt-5.6-terra` | `medium` |
| Mechanical command runner, cheap lookup, repetitive execution | `gpt-5.4-mini` (default) — `gpt-5.6-luna` available when 5.6-era capability/cutoff matters (not the default) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only, not an effort setting of the flagship | `low` |

Rules:

- Debate roles always use `gpt-5.6-sol`.
- Do not use mini models for security-sensitive validation or launch go/no-go decisions.
- Do not run every subtask on `gpt-5.6-sol`; distribute by task shape.
- If a model is unavailable or rate-limited, record the limitation and choose the nearest safe fallback. Do not silently downgrade debate below `gpt-5.6-sol`.

## Claude-side mapping (when coordinating with Claude agents)

When this skill coordinates with anti-hall deadly-loop or ship-it, the Claude-side tier token `sonnet` resolves to **the latest Sonnet** at runtime. Claude-side role assignments:

- Reviewer (deadly-loop/ship-it): `model:"fable"` (Fable) when available, else `model:"sonnet"` = Sonnet, effort `xhigh`
- Planning secondary / medium scope: `model:"sonnet"` = Sonnet, effort `xhigh`
- Implementation failover (when Codex unavailable): `model:"sonnet"` = Sonnet, effort `high`
- Main coordinator, planning top-level, deep debug: `model:"opus"` = Opus

Cross-model rule: if Codex implements, Claude (Sonnet or Opus) reviews. If Sonnet implements, Codex or Opus reviews. No agent reviews its own implementation.

**Never pin a model version.** Route by tier token (`opus`/`sonnet`/`haiku`/`fable`) — the harness resolves each to the newest model in that family. A version number written into a policy, prompt, or workflow goes stale the day a new model ships.
