#!/usr/bin/env node
'use strict';
// B0 probe hook (docs/BENCHMARK-METHOD.md Amendment 3, probes P3, P4, P8, P9).
// Writes the hook's stdin payload (plus the env var P9 asks about) to
// <cwd>/.probe/<n>.json, and emits a uuid token so graders can find where it landed:
//   PreToolUse  -> additionalContext "PROBE-PRE-<uuid>"
//   PostToolUse -> additionalContext "PROBE-POST-<uuid>"
//   SessionStart-> additionalContext "PROBE-START-<source>-<uuid>"
//   Stop        -> blocks ONCE ("PROBE-STOP-<uuid>"), then lets the session end (P8)
// Never touches anything outside <cwd>/.probe. Pure Node built-ins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const event = process.argv[2];
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch (_) { /* log raw below */ }
  const cwd = input.cwd || process.cwd();
  const dir = path.join(cwd, '.probe');
  const uuid = crypto.randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const n = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).length + 1;
    fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ event, token: uuid, input, rawParsed: raw ? !!Object.keys(input).length : false, env: { ANTIHALL_MODEL_ROUTING: process.env.ANTIHALL_MODEL_ROUTING ?? null } }, null, 2));
  } catch (_) { /* a probe must never break the run */ }
  const out = (o) => fs.writeSync(1, JSON.stringify(o));
  if (event === 'PreToolUse') out({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `PROBE-PRE-${uuid}` } });
  else if (event === 'PostToolUse') out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `PROBE-POST-${uuid}` } });
  else if (event === 'SessionStart') out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `PROBE-START-${input.source || 'unknown'}-${uuid}` } });
  else if (event === 'Stop') {
    const flag = path.join(dir, 'stop-blocked');
    if (!fs.existsSync(flag) && !input.stop_hook_active) {
      try { fs.writeFileSync(flag, uuid); } catch (_) { /* fall through: allow stop */ }
      if (fs.existsSync(flag)) out({ decision: 'block', reason: `PROBE-STOP-${uuid}: acknowledge this token in one short line, then stop.` });
    }
  }
  process.exit(0);
});
