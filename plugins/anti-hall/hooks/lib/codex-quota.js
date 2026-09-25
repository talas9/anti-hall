'use strict';
// anti-hall :: codex-quota — shared read/write for a Codex-CLI quota-exhaustion
// record, layered onto ~/.anti-hall/codex-availability.json (the same file
// codex-availability.js's SessionStart PATH probe already owns).
//
// ROOT CAUSE this addresses (0.111 item 2): a codex:codex-rescue quota error
// ("out of quota until <time>") was previously rediscovered independently by
// every lane/session that happened to hit it — each one burning a spawn +
// wait just to learn Codex is down. This module gives every caller ONE place
// to read/write "Codex is known-unavailable until <time>, because <reason>",
// so a hint or routing check can skip the wasted spawn.
//
// FILE SHAPE (merged, never overwrites the PATH-probe fields):
//   {
//     available, checkedAt, source,     // written by codex-availability.js
//     quota: { available: false, until, reason, recordedAt } | undefined
//   }
// `quota` is present only while a quota outage is recorded; isExhausted()
// treats a missing/expired/malformed record as "not exhausted" (fail-open —
// this module only ever SUPPRESSES a spawn via advisory text, it never blocks
// one, so failing toward "assume available" is the safe direction).
//
// Pure Node built-ins. Every write is atomic (tmp + rename) and merges with
// whatever the file already holds instead of clobbering the PATH-probe half.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function statePath(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'codex-availability.json');
}

function readRaw(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(home), 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// writeMerged(home, patch) — shallow-merge `patch` into the existing file,
// atomic tmp+rename. Best-effort: never throws.
function writeMerged(home, patch) {
  try {
    const p = statePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const merged = Object.assign({}, readRaw(home), patch);
    const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

// recordQuota({ until, reason, home, now }) — record a Codex quota outage.
// `until` is an epoch-ms number (or an ISO/parseable string) marking when
// Codex is expected to become available again; a non-finite/unparseable
// value falls back to DEFAULT_COOLDOWN_MS from `now` so a record always
// self-expires (never wedges Codex "unavailable" forever on a bad parse).
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1h — conservative, self-healing
function recordQuota(opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  let until = typeof o.until === 'number' ? o.until : Date.parse(o.until);
  if (!Number.isFinite(until) || until <= now) until = now + DEFAULT_COOLDOWN_MS;
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 300) : 'quota exhausted';
  return writeMerged(o.home, {
    quota: { available: false, until, reason, recordedAt: now },
  });
}

// clearQuota({home}) — remove a stale/manually-cleared record.
function clearQuota(opts) {
  const o = opts || {};
  try {
    const p = statePath(o.home);
    const merged = readRaw(o.home);
    delete merged.quota;
    const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

// readQuota({home, now}) -> { exhausted, until, reason, recordedAt } | { exhausted: false }
// An expired or malformed record reads back as not-exhausted (fail-open).
function readQuota(opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const raw = readRaw(o.home);
  const q = raw && raw.quota;
  if (!q || typeof q !== 'object') return { exhausted: false };
  const until = Number.isFinite(q.until) ? q.until : NaN;
  if (!Number.isFinite(until) || until <= now) return { exhausted: false };
  return {
    exhausted: true,
    until,
    reason: typeof q.reason === 'string' ? q.reason : 'quota exhausted',
    recordedAt: Number.isFinite(q.recordedAt) ? q.recordedAt : null,
  };
}

// QUOTA_RE — conservative match for a Codex CLI quota/rate-limit exhaustion
// message. The exact wording was NOT found verified anywhere in this repo or
// this machine's ~/.codex logs (searched at authoring time), so this matches
// broadly on the "quota"/"rate limit" + exhaustion vocabulary rather than one
// exact string, and separately tries to capture a trailing "until <...>"
// clause for the expiry time. Case-insensitive.
const QUOTA_RE = /\b(out of|exceed(?:ed|s)?|exhausted|hit (?:your|the)|ran out of)\b[^.\n]{0,40}\b(quota|rate limit|usage limit)\b/i;
// Captures up to a sentence boundary WITHOUT splitting on a bare '.' — an ISO
// timestamp's fractional seconds ("00:00:00.000Z") contain one. A sentence
// boundary is a '.'/','/';' followed by whitespace-or-end, a newline, or the
// end of the string; non-greedy so it stops at the FIRST such boundary.
const UNTIL_RE = /\b(?:until|resets?(?: at)?|resum(?:e|ing)(?: at)?|available again(?: at)?)\s+([^\n]{1,80}?)(?:[.,;](?=\s|$)|\n|$)/i;

// detectQuotaMessage(text) -> { reason, until } | null. `until` is an epoch-ms
// number when a trailing clause parses as a date, else null (caller falls
// back to DEFAULT_COOLDOWN_MS).
function detectQuotaMessage(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(QUOTA_RE);
  if (!m) return null;
  const reasonStart = Math.max(0, m.index);
  const reason = text.slice(reasonStart, reasonStart + 120).replace(/\s+/g, ' ').trim();
  let until = null;
  const u = text.slice(m.index).match(UNTIL_RE);
  if (u) {
    const parsed = Date.parse(u[1].trim());
    if (Number.isFinite(parsed)) until = parsed;
  }
  return { reason, until };
}

module.exports = {
  statePath, recordQuota, clearQuota, readQuota, detectQuotaMessage, DEFAULT_COOLDOWN_MS,
};
