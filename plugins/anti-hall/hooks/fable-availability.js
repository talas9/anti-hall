#!/usr/bin/env node
// anti-hall :: fable-availability (SessionStart)
//
// Reads Claude Code's local model cache once per session start and records whether
// a Fable model is available for workflow routing. No probing, no network.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const STATE_FILE = path.join(os.homedir(), '.anti-hall', 'fable-availability.json');
const CONTEXT =
  "Fable 5 is available this session (per ~/.claude.json). MODEL-POLICY.md's Reviewer seat may route to Fable when invoking ship-it/deadly-loop -- pass args.fableAvailable=true to the Workflow.";

function hasFable(value) {
  return typeof value === 'string' && value.toLowerCase().includes('fable');
}

function detectAvailability(config) {
  const access = Array.isArray(config.modelAccessCache) ? config.modelAccessCache : [];
  for (const entry of access) {
    if (entry && hasFable(entry.apiName)) {
      return {
        available: entry.entitled === true,
        source: 'modelAccessCache',
      };
    }
  }

  const options = Array.isArray(config.additionalModelOptionsCache)
    ? config.additionalModelOptionsCache : [];
  for (const entry of options) {
    if (entry && (hasFable(entry.value) || hasFable(entry.model) || hasFable(entry.label))) {
      return {
        available: entry.disabled !== true,
        source: 'additionalModelOptionsCache',
      };
    }
  }

  return { available: null, source: 'unknown' };
}

function writeState(result) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    available: result.available,
    checkedAt: Date.now(),
    source: result.source,
  }), 'utf8');
}

function emitContext() {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: CONTEXT,
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

function main() {
  let result = { available: null, source: 'unknown' };
  try {
    const raw = fs.readFileSync(CLAUDE_JSON, 'utf8');
    result = detectAvailability(JSON.parse(raw));
  } catch (_) {
    result = { available: null, source: 'unknown' };
  }

  try {
    writeState(result);
  } catch (_) {
    return;
  }

  if (result.available === true) emitContext();
}

try {
  main();
} catch (_) {
  // Fail-open: SessionStart must never be blocked by availability detection.
}
process.exit(0);
