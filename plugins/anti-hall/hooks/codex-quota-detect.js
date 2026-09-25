#!/usr/bin/env node
// anti-hall :: codex-quota-detect (PostToolUse, matcher Agent)
//
// 0.111 item 2: when a codex:codex-rescue Agent call comes back with a quota/
// rate-limit exhaustion message, record it ONCE via lib/codex-quota.js
// instead of every lane rediscovering the outage on its own next spawn.
// Advisory only — never blocks, never fails the tool call, no stdout unless
// the Agent result is Codex-quota-shaped.
//
// Only fires for an Agent tool_input whose subagent_type/agentType names the
// Codex rescue seat (accepts 'codex:codex-rescue', 'codex-rescue', or a
// 'codex:' prefix ending in 'rescue' — the plugin-qualified form varies by
// how the coordinator invoked it). Scans tool_response/tool_output (whichever
// the harness populates — see output-verify-guard.js's FIELD-SHAPE CAVEAT,
// same uncertainty applies here) for lib/codex-quota.js's QUOTA_RE.
//
// Contract (Claude Code PostToolUse hook):
//   stdin  : JSON { tool_name, tool_input, tool_response?, tool_output?, ... }
//   stdout : nothing (state-only + a short advisory note on a positive match)
//   exit 0 : always — fail-open, never blocks.
// Pure Node built-ins.

'use strict';

const fs = require('fs');

const CODEX_RESCUE_RE = /^codex[:/-]?(?:codex-)?rescue$/i;
const SCAN_CAP = 20000;

function isCodexRescue(subagentType) {
  return typeof subagentType === 'string' && CODEX_RESCUE_RE.test(subagentType.trim());
}

// buildBlob — same "stringify whatever shape we got" approach as
// output-verify-guard.js's buildBlob(), for the same documented reason.
function buildBlob(payload) {
  const parts = [];
  for (const key of ['tool_response', 'tool_output']) {
    const v = payload && payload[key];
    if (v == null) continue;
    try { parts.push(typeof v === 'string' ? v : JSON.stringify(v)); } catch (_) { /* skip */ }
  }
  let blob = parts.join('\n');
  if (blob.length > SCAN_CAP) blob = blob.slice(0, SCAN_CAP);
  return blob;
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }

  try {
    if (require('./lib/settings.js').get('guards', 'codexQuotaDetect', true) === false) return;
  } catch (_) { /* run */ }

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }
  if (!payload || payload.tool_name !== 'Agent') return;

  const input = payload.tool_input || {};
  const subagentType = input.subagent_type || input.agentType || input.agent_type;
  if (!isCodexRescue(subagentType)) return;

  const blob = buildBlob(payload);
  if (!blob) return;

  let hit = null;
  try { hit = require('./lib/codex-quota.js').detectQuotaMessage(blob); } catch (_) { hit = null; }
  if (!hit) return;

  try {
    require('./lib/codex-quota.js').recordQuota({
      until: hit.until, reason: hit.reason,
    });
  } catch (_) { return; }

  try {
    const until = hit.until ? new Date(hit.until).toISOString() : '(cooldown default)';
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'CODEX QUOTA: codex:codex-rescue reported quota exhaustion (' +
          hit.reason + '). Recorded to ~/.anti-hall/codex-availability.json, until ' + until +
          '. Codex unavailable until then; route correctness review to Sonnet.',
      },
    };
    fs.writeSync(1, JSON.stringify(out) + '\n');
  } catch (_) { /* recording already happened; the note is best-effort */ }
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);
