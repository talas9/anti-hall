---
name: anti-hall-flutter-debug
description: Codex-native Flutter debugging loop. Use when debugging Flutter apps, simulator/emulator behavior, UI regressions, or widget/service failures.
---

# anti-hall Flutter debug for Codex

Use a verify-first debug loop:

1. Reproduce the issue with the smallest command or UI path.
2. Capture concrete evidence: exception, log line, screenshot, failing test, or simulator state.
3. Trace root cause in Dart/Flutter code before editing.
4. Apply the smallest scoped fix.
5. Re-run the reproduction path or test.
6. If UI changed, verify visually with available browser/simulator tooling or screenshots.

Model routing:

- root-cause analysis and tricky UI/state bugs: `gpt-5.6-sol`
- implementation after cause is proven: `gpt-5.6-terra`
- command-only build/test runner: `gpt-5.4-mini` (default; `gpt-5.6-luna` available when 5.6-era capability/cutoff matters) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only

Avoid long-running watcher commands. Use bounded runs and clean up spawned test/build processes.
