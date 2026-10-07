// anti-hall :: turn-gate — "has this advisory already been shown THIS turn?"
//
// ROOT CAUSE this addresses: per-tool-call advisories (failure-root-cause-nudge
// on PostToolUseFailure, output-verify-guard on PostToolUse) fire once per
// matching tool call. An agent that runs ten commands in one turn sees the
// identical reminder ten times; a field scan found ~40% of root-cause nudges
// were a 2nd+ nudge inside one human turn (CHANGELOG has the exact counts).
// The reminder text does not change between calls, so repeats add tokens, not
// information.
//
// "TURN" = the span after the latest HUMAN prompt in the session transcript
// (a `user` entry that is not a tool_result and not an injected
// <task-notification>/<system-reminder>/<local-command>/<command-name> block).
// Its uuid (else timestamp) is the turn id. A subagent payload carries
// `agent_id`; its "turn" is its own whole run (the subagent never sees the
// parent's reminders), so the id is `agent:<agent_id>`.
//
// firstThisTurn({ home, sessionId, agentId, transcriptPath, key, sig }) -> bool
//   true  = show it (first time for this key+sig this turn, OR the turn cannot
//           be determined — fail-OPEN, never swallow an advisory on doubt)
//   false = already shown this turn, suppress
// `sig` lets a caller treat different content as different advisories (e.g.
// output-verify's matched snippet); omit it for "once per turn per key".
//
// State: <home>/.anti-hall/turn-gate/tg-<sessionId>.json
//   { "<key>|<agent>": { turn, sigs: [..] } }   (bounded: 16 sigs per key)
// Written atomically; session files older than 7 days are pruned by
// lib/state-prune.js. Pure Node built-ins.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'tg'; // state-prune.js appends the '-' itself
const TAIL_BYTES = 512 * 1024;
const MAX_SIGS = 16;
const INJECTED_RE = /^\s*<(?:task-notification|system-reminder|local-command|command-name|command-message)/;

function stateFile(home, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return path.join(home, '.anti-hall', 'turn-gate', PREFIX + '-' + safe + '.json');
}

function humanText(msg) {
  if (!msg) return null;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    if (msg.content.some((c) => c && c.type === 'tool_result')) return null;
    const t = msg.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
    return t || null;
  }
  return null;
}

// currentTurnId(transcriptPath) -> string | null. Newest human prompt in the
// capped transcript tail; null when none can be found (huge tool output pushed
// it out of the tail, no transcript, unreadable).
function currentTurnId(transcriptPath) {
  const lines = require('./transcript-tail.js').readTail(transcriptPath, TAIL_BYTES);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"user"') === -1) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || o.type !== 'user' || o.isMeta || o.isSidechain) continue;
    const t = humanText(o.message);
    if (!t || INJECTED_RE.test(t)) continue;
    return String(o.uuid || o.timestamp || '') || null;
  }
  return null;
}

function firstThisTurn(opts) {
  try {
    const o = opts || {};
    if (!o.sessionId || !o.key) return true;
    const home = o.home || os.homedir();
    const turn = o.agentId ? 'agent:' + o.agentId : currentTurnId(o.transcriptPath);
    if (!turn) return true; // cannot tell -> never suppress
    const slot = String(o.key) + '|' + (o.agentId || 'main');
    const sig = o.sig === undefined ? '' : String(o.sig).slice(0, 200);
    const p = stateFile(home, o.sessionId);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch (_) { state = {}; }
    const prev = state[slot];
    if (prev && prev.turn === turn && Array.isArray(prev.sigs) && prev.sigs.indexOf(sig) !== -1) return false;
    const sigs = prev && prev.turn === turn && Array.isArray(prev.sigs) ? prev.sigs.slice(-(MAX_SIGS - 1)) : [];
    sigs.push(sig);
    state[slot] = { turn, sigs };
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, p);
      require('./state-prune.js').pruneStale({ stateDir: path.dirname(p), prefix: PREFIX, keepFile: p });
    } catch (_) { return true; } // cannot persist -> show it
    return true;
  } catch (_) {
    return true;
  }
}

module.exports = { firstThisTurn, currentTurnId };
