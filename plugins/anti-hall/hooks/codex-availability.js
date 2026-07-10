#!/usr/bin/env node
// anti-hall :: codex-availability (SessionStart)
//
// Probes whether a real `codex` executable is on PATH and records the result once
// per session start, so coordinators/skills can read the fact instead of
// re-probing. Pure Node built-ins, OS-agnostic (Windows/macOS/Linux) -- walks PATH
// honoring Windows PATHEXT, matching a real executable (never a shell alias).
//
// IMPORTANT: this proves the binary is reachable on PATH. It does NOT prove the
// Codex CLI is authenticated or ready to run -- a spawn can still fail at runtime.
// Coordinators must take the documented Opus/Sonnet fallback if a Codex spawn
// returns null, even when this hook reported available:true.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.anti-hall', 'codex-availability.json');
const CONTEXT =
  "Codex binary detected on PATH (per a SessionStart PATH probe). This proves the " +
  "binary is reachable, NOT that it is authenticated/ready -- if a Codex spawn " +
  "returns null at runtime, take the documented Opus/Sonnet fallback. Prefer " +
  "agentType:'codex:codex-rescue' for the deadly-loop/ship-it Critic seat, and for " +
  "everyday correctness-review plus a share of implementation load. Coordinators " +
  "should read ~/.anti-hall/codex-availability.json instead of re-probing.";

// OS-agnostic PATH probe (mirrors plugins/anti-hall/skills/MODEL-POLICY.md's
// codex-available.js reference probe): exit-code-free version returning a bool.
function probeCodexOnPath() {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => exts.some((e) => {
    try {
      fs.accessSync(path.join(d, 'codex' + e.toLowerCase()), fs.constants.X_OK);
      return true;
    } catch (_) {
      try {
        fs.accessSync(path.join(d, 'codex' + e), fs.constants.F_OK);
        return true;
      } catch (_) {
        return false;
      }
    }
  }));
}

function writeState(available) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    available,
    checkedAt: Date.now(),
    source: 'path-probe',
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
  let available = false;
  try {
    available = probeCodexOnPath();
  } catch (_) {
    available = false;
  }

  try {
    writeState(available);
  } catch (_) {
    return;
  }

  if (available === true) emitContext();
}

try {
  main();
} catch (_) {
  // Fail-open: SessionStart must never be blocked by availability detection.
}
process.exit(0);
