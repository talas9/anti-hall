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
5. Apply the smallest fix that addresses the proven cause. Fixing an anti-hall bug? First run `node <plugin-root>/scripts/defect.js similar <symptom words> --component <module>` and read the past fixes for this component; if `defect.js recurring` lists it as a hotspot, fix the class, not the instance.
6. Re-run the authoritative check this turn before saying fixed/passing.

Codex model routing:

- Ambiguous diagnosis, architecture, or safety-sensitive analysis: **frontier**
- Implementation once cause is proven: **workhorse**
- Simple command execution / file lookup subtask: **fast**

Do not copy raw noisy command output into the final answer. Summarize findings with evidence references.
