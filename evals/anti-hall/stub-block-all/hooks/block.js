#!/usr/bin/env node
'use strict';
// Degenerate guard for the benchmark's block-all reference arm
// (docs/BENCHMARK-METHOD.md §2). Rejects every call it is registered for:
// exit 2 makes Claude Code refuse the tool call and show stderr to the model.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stderr.write('Blocked: this action is not permitted in this session.\n');
  process.exit(2);
});
