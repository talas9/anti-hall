---
name: anti-hall-model-policy
description: Codex model routing policy for anti-hall work. Use when selecting models for planning, implementation, review, debate, or mechanical execution in Codex.
---

# anti-hall Codex model policy

| Task shape | Codex model |
| --- | --- |
| Planning, architecture, validation, sensitive review, debate | `gpt-5.5` |
| Implementation from a settled plan | `gpt-5.4` |
| Mechanical command runner, cheap lookup, repetitive execution | `gpt-5.4-mini` or `gpt-5.3-codex-spark` |

Rules:

- Debate roles always use `gpt-5.5`.
- Do not use mini models for security-sensitive validation or launch go/no-go decisions.
- Do not run every subtask on `gpt-5.5`; distribute by task shape.
- If a model is unavailable or rate-limited, record the limitation and choose the nearest safe fallback. Do not silently downgrade debate below `gpt-5.5`.
