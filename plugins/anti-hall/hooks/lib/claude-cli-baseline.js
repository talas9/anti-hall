'use strict';
// anti-hall :: claude-cli-baseline — the SINGLE authoritative source for the
// Claude Code CLI (harness) version anti-hall's harness-feature KB
// (docs/KB-claude-code-harness-features.md) was last audited against.
//
// Consumed by:
//   - hooks/claude-cli-version.js         (SessionStart advisory)
//   - hooks/claude-cli-version-refresh.js (background probe; writes cache.baseline)
//
// Motivation (measured this session, 2026-08-22): the harness KB was audited
// against local Claude Code version 2.1.238 (docs/KB-claude-code-harness-
// features.md:16, "2026-08-21 (local Claude Code version 2.1.238)"), and the
// installed binary was independently observed moving 2.1.238 -> 2.1.239
// WITHIN A SINGLE DAY, with no signal. This baseline is the fix — bump it
// deliberately whenever the harness KB is re-audited against a newer build.
const CLAUDE_CLI_BASELINE = '2.1.238';

module.exports = { CLAUDE_CLI_BASELINE };
