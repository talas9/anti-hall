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

- root-cause analysis and tricky UI/state bugs: **frontier**
- implementation after cause is proven: **workhorse**
- command-only build/test runner: **fast**

Avoid long-running watcher commands. Use bounded runs and clean up spawned test/build processes.
