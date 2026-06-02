#!/usr/bin/env node
// skip-guard.js — shared escape hatch for anti-hall guards.
//
// PRINCIPLE: the user's explicit instruction outranks any guard. When the user
// CLEARLY and DIRECTLY asks the agent to skip a guard/rule, the agent records
// that consent here; every guard checks it at startup and fail-opens (does not
// interfere) while it is in effect.
//
// MECHANISM: a TTL'd JSON marker at ~/.anti-hall/skip.json, e.g.
//   { "speculation-guard": 1736900000000, "all": 1736900000000 }
// where each value is a Unix-ms EXPIRY. The agent writes it (default TTL 15
// min) when the user explicitly opts out; it auto-expires so a safety guard is
// never left silently disabled. The agent — not this file — is the
// natural-language layer; this file stays dumb and deterministic.
//
// GRANULARITY (safe default): a broad "all" skip covers the noisy guards but
// NOT the destructive git-guard checks (force-push / AI-credit trailer). To
// skip git-guard the agent must name it explicitly (data["git-guard"]).
//
// FAIL DIRECTION: any error (missing/corrupt file) => isSkipped returns false
// => the guard stays ACTIVE. A broken skip file must never silently disable a
// guard. (This is the opposite of the hooks' own fail-OPEN: there a hook bug
// must not block the user; here a skip-file bug must not disable protection.)

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKIP_FILE = path.join(os.homedir(), '.anti-hall', 'skip.json');

// Guards NOT covered by a broad "all" skip — they must be named explicitly.
const DESTRUCTIVE = new Set(['git-guard']);

// isSkipped(name): true when an unexpired, applicable skip is recorded.
//   - data[name]  > now            -> skip this guard (covers destructive when named)
//   - data.all    > now            -> skip, UNLESS name is destructive
function isSkipped(name) {
  try {
    const raw = fs.readFileSync(SKIP_FILE, 'utf8').trim();
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return false;
    const now = Date.now();

    const own = data[name];
    if (typeof own === 'number' && own > now) return true;

    if (!DESTRUCTIVE.has(name)) {
      const all = data.all;
      if (typeof all === 'number' && all > now) return true;
    }
    return false;
  } catch (_) {
    // No marker / unreadable / bad JSON -> guard stays ACTIVE (safe direction).
    return false;
  }
}

module.exports = { isSkipped, SKIP_FILE, DESTRUCTIVE };
