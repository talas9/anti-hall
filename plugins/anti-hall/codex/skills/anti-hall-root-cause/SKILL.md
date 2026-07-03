---
name: anti-hall-root-cause
description: Codex-native root-cause debugging discipline. Use when investigating a bug, failing test, broken config, or runtime behavior before proposing or applying a fix.
---

# anti-hall root cause for Codex

Apply the Iron Law:

> No claim without evidence; no fix without a proven root cause.

Workflow:

1. Capture the observed failure exactly: command, input, output, stack trace, affected file, or UI state.
2. Verify the relevant code/config/data with tools before making factual claims.
3. Trace from symptom to root cause. Do not patch the first suspicious line.
4. If evidence is insufficient, add targeted instrumentation or request the exact missing repro/log.
5. Apply the smallest fix that addresses the proven cause.
6. Re-run the authoritative check this turn before saying fixed/passing.

Codex model routing:

- Ambiguous diagnosis, architecture, or safety-sensitive analysis: `gpt-5.5`
- Implementation once cause is proven: `gpt-5.4`
- Simple command execution / file lookup subtask: `gpt-5.4-mini` (default) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only

Do not copy raw noisy command output into the final answer. Summarize findings with evidence references.
