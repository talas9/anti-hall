'use strict';
// anti-hall :: stop-policy — the ONE shared Stop-block policy for the DevSwarm
// parent and child gates (mesh redesign Phase 5, #14).
//
// Field evidence (plan §Evidence "Hooks"): 369 Stop-gate blocks in one
// transcript. Two causes, both fixed here for both gates:
//   1. `stop_hook_active` was ignored — a block that the model answered by
//      stopping again was blocked again, back to back.
//   2. The cap bucket was keyed by CONTENT (unread counts, message hashes), so
//      mail landing mid-drain ("N unread (cached)" changing to N+1) opened a
//      fresh budget every time — the gate amplified itself.
//
// Policy (both gates):
//   - stopHookActive(payload) === true -> allow immediately, before any state
//     write or probe (the model is already continuing because of a block).
//   - The cap is keyed by a STABLE block kind (`<session>|<hook>|<kind>`),
//     never by counts or content. A kind's counter resets only when its
//     condition is observed CLEARED (clear()) — new mail arriving while the
//     condition persists never re-opens the budget.
//   - consume() blocks while ANY active kind is under its cap and increments
//     those kinds; at cap for every active kind it allows the stop.
//   - A cap state that cannot be persisted allows the stop (a guard that
//     cannot count its own blocks must never block — fail-open, as before).
//   - UNKNOWN unread is its own reason, not silence: callers include the
//     mailbox kind when the count is unknown, so it still blocks (capped) with
//     a reason naming the unknown state.
//
// Pure Node built-ins. Never throws.

const fs = require('fs');
const path = require('path');

function stopHookActive(payload) {
  return !!(payload && payload.stop_hook_active === true);
}

// kindSignature(kinds) -> a stable, content-free signature of a set of kinds.
function kindSignature(kinds) {
  return Array.from(new Set((kinds || []).map(String))).sort().join(',');
}

function statePath(home, sessionId) {
  const safe = String(sessionId == null ? 'unknown' : sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(String(home), '.anti-hall', 'devswarm', 'stop-policy', safe + '.json');
}

function readBuckets(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) { return {}; }
}

function writeBuckets(file, buckets) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(buckets));
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

function key(sessionId, hook, kind) { return String(sessionId) + '|' + String(hook) + '|' + String(kind); }

// consume(home, sessionId, hook, kinds, cap, now) -> { block, counts, exhausted, persisted }.
function consume(home, sessionId, hook, kinds, cap, now) {
  const file = statePath(home, sessionId);
  const buckets = readBuckets(file);
  const counts = {};
  const open = [];
  const exhausted = [];
  for (const k of Array.from(new Set((kinds || []).map(String)))) {
    const b = buckets[key(sessionId, hook, k)];
    const n = b && Number.isFinite(b.count) ? b.count : 0;
    counts[k] = n;
    if (n < cap) open.push(k); else exhausted.push(k);
  }
  if (!open.length) return { block: false, counts, exhausted, persisted: true };
  for (const k of open) {
    counts[k] += 1;
    buckets[key(sessionId, hook, k)] = { count: counts[k], lastAt: Number.isFinite(now) ? now : Date.now() };
  }
  const persisted = writeBuckets(file, buckets);
  return { block: persisted, counts, exhausted, persisted };
}

// clear(home, sessionId, hook, kinds?) — the condition was recounted CLEAR:
// reset those kinds' counters (all of this hook's kinds when omitted).
function clear(home, sessionId, hook, kinds) {
  const file = statePath(home, sessionId);
  const buckets = readBuckets(file);
  const prefix = String(sessionId) + '|' + String(hook) + '|';
  const only = kinds ? new Set(kinds.map((k) => prefix + String(k))) : null;
  let changed = false;
  for (const k of Object.keys(buckets)) {
    if (!k.startsWith(prefix)) continue;
    if (only && !only.has(k)) continue;
    delete buckets[k];
    changed = true;
  }
  if (changed) writeBuckets(file, buckets);
}

// ---------------------------------------------------------------------------
// Per-prompt Stop-nag budget (cost-trim Phase 1; setting guards.stopNagBudgetPerPrompt,
// default 0 = off = today's behaviour). task-guard and tasklist-guard consult it
// just before they emit a block. One bucket per (session, hook) holding
// {promptKey, count, lastAt}: a new prompt key restarts the count, so the cap is
// per user prompt and the guards' own session caps stay the outer bound.
// ---------------------------------------------------------------------------

// budgetPerPrompt(opts) -> integer >= 0 (0 = off). Any settings error -> 0 (today's behaviour).
function budgetPerPrompt(opts) {
  try {
    const v = require('./settings.js').get('guards', 'stopNagBudgetPerPrompt', 0, opts);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch (_) { return 0; }
}

// promptKey(payload, transcriptPath) -> string | null. `prompt_id` from the Stop payload
// when present, else the uuid of the last REAL user entry in the transcript tail (a user
// entry whose content is only tool_result blocks, or that is meta/sidechain, is not a prompt).
function promptKey(payload, transcriptPath) {
  try {
    if (payload && typeof payload.prompt_id === 'string' && payload.prompt_id) return payload.prompt_id;
    const lines = require('./transcript-tail.js').readTail(transcriptPath);
    if (!Array.isArray(lines)) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i] && lines[i].trim();
      if (!t || t.indexOf('"user"') === -1) continue;
      let e;
      try { e = JSON.parse(t); } catch (_) { continue; }
      if (!e || e.type !== 'user' || e.isMeta === true || e.isSidechain === true) continue;
      if (typeof e.uuid !== 'string' || !e.uuid) continue;
      const c = e.message && e.message.content;
      const real = typeof c === 'string' ? c.trim() !== ''
        : Array.isArray(c) && c.some((b) => b && b.type !== 'tool_result');
      if (real) return e.uuid;
    }
  } catch (_) { /* fall through */ }
  return null;
}

// consumePrompt(home, sessionId, hook, key, budget, now) -> { block, count, persisted }.
// block=true while this prompt has used fewer than `budget` blocks for this hook (the count is
// incremented); block=false once spent. An unpersistable count allows the stop (fail-open).
function consumePrompt(home, sessionId, hook, key, budget, now) {
  const file = statePath(home, sessionId);
  const buckets = readBuckets(file);
  const bk = String(sessionId) + '|' + String(hook) + '|prompt';
  const b = buckets[bk];
  const same = b && b.promptKey === key && Number.isFinite(b.count);
  const n = same ? b.count : 0;
  if (n >= budget) return { block: false, count: n, persisted: true };
  buckets[bk] = { promptKey: key, count: n + 1, lastAt: Number.isFinite(now) ? now : Date.now() };
  const persisted = writeBuckets(file, buckets);
  return { block: persisted, count: n + 1, persisted };
}

// budgetSpent({home, sessionId, hook, payload, transcriptPath, env}) -> true when the
// per-prompt budget is ON and spent for this prompt (the guard must NOT block). Off, no prompt
// key, or any error -> false (today's behaviour).
function budgetSpent(o) {
  try {
    const opts = { home: o.home, env: o.env };
    const budget = budgetPerPrompt(opts);
    if (!budget) return false;
    const key = promptKey(o.payload, o.transcriptPath);
    if (!key) return false;
    return !consumePrompt(o.home, o.sessionId, o.hook, key, budget, o.now).block;
  } catch (_) { return false; }
}

module.exports = { stopHookActive, kindSignature, statePath, consume, clear, budgetPerPrompt, promptKey, consumePrompt, budgetSpent };
