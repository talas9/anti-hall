'use strict';
// anti-hall :: devswarm-maintainer-notice — a one-way broadcast channel the
// anti-hall DEV agent (working on this repo's own checkout) uses to reach
// every OTHER project's DevSwarm Primary. NOT a store/mesh feature: it never
// writes into any project's store/*, and posting NEVER seats this process as
// a Primary. Pure fs, ~/.anti-hall/devswarm/maintainer-notices.jsonl (one
// shared append-only log) + a per-repoKey read cursor.
//
// SAFETY MODEL — read this before touching `post()`:
//   `post()` is refused unless BOTH:
//     1. settings devswarm.maintainerNotice.post === true (off by default)
//     2. the CALLING checkout's own plugins/anti-hall/.claude-plugin/plugin.json
//        has "name": "anti-hall" (i.e. this literally IS the anti-hall repo,
//        not some other project with the setting flipped on by habit/mistake)
//   This is a MISTAKE GUARD, not authentication — anyone with write access to
//   ~/.anti-hall/settings.json and a clone of this repo can flip it. It exists
//   only to keep an accidental `--post` from a random project (where the
//   setting might be on for other reasons, or copy-pasted from this repo's own
//   settings.json) from broadcasting to every other project's Primary. Docs and
//   every refusal message say this explicitly.
//
// LIMITS (enforced in post(), never bypassable via flags):
//   - at most 3 posts per rolling 24h (counts existing rows in the log with
//     ts within the last 24h — no separate counter file, so a corrupted/
//     truncated log fails open toward FEWER allowed posts, never more)
//   - each notice's `text` <= 2048 bytes (UTF-8)
//   - `list()`/consumers show at most 5 UNEXPIRED notices (oldest-eligible
//     dropped first — newest 5 win)
//   - expired notices are HIDDEN from list()/show, NEVER deleted (repo rule:
//     no automated deletion). The jsonl file only ever grows; nothing here
//     prunes it.
//
// CURSOR — one per repoKey, ~/.anti-hall/devswarm/maintainer-notice-cursor/
// <repoKey>.json: { lastSeenId }. unseenFor(repoKey) returns unexpired
// notices with an id NOT YET marked seen for that repoKey (id ordering is
// insertion order in the log, which is also chronological since it's
// append-only). markSeen(repoKey, id) advances the cursor to at least `id`
// (monotonic — never regresses).
//
// METRICS (companion/lib/alog.js event log, best-effort, never blocks):
//   - post: devswarm-maintainer-notice / post (ok / refused:<reason>)
//   - primaries that saw a notice + time-to-seen: devswarm-maintainer-notice /
//     seen, one event per (repoKey, notice id) the FIRST time it is surfaced,
//     carrying ageMs = now - notice.ts (time-to-seen).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { devswarmRoot, isSafeId } = require('./liveness.js');
const testHomeGuard = require('./test-home-guard.js');

const MAX_TEXT_BYTES = 2048;
const MAX_POSTS_PER_DAY = 3;
const MAX_SHOWN = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * DAY_MS;

function homeOf(opts) { return testHomeGuard.resolveHome(opts && opts.home, opts && opts.env); }

function noticesPath(home) { return path.join(devswarmRoot(home), 'maintainer-notices.jsonl'); }
function cursorDir(home) { return path.join(devswarmRoot(home), 'maintainer-notice-cursor'); }
function cursorPath(home, repoKey) {
  if (typeof repoKey !== 'string' || !repoKey || !/^[A-Za-z0-9._-]+$/.test(repoKey)) {
    throw new Error('unsafe repoKey: ' + JSON.stringify(repoKey));
  }
  return path.join(cursorDir(home), repoKey + '.json');
}

let alog = null;
function logEvent(kind, level, message, fields) {
  try {
    if (!alog) alog = require('./anti-hall-log.js');
    alog.logEvent('devswarm-maintainer-notice', kind, level, message, fields || {});
  } catch (_) { /* metrics must never break the feature */ }
}

// readAllRows(home, F) -> [] on any read/parse failure (fail-open, no throw).
// Tolerant NDJSON parse: a corrupt trailing line is skipped, not fatal.
function readAllRows(home, fsi) {
  const F = fsi || fs;
  let raw;
  try { raw = F.readFileSync(noticesPath(home), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object' && row.id) out.push(row);
    } catch (_) { /* skip corrupt line */ }
  }
  return out;
}

function isExpired(row, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  return Number.isFinite(row.expiresAt) && row.expiresAt <= n;
}

// unexpiredCapped(rows, now) -> newest MAX_SHOWN unexpired rows, oldest-first
// (display order), never mutating/deleting the underlying rows.
function unexpiredCapped(rows, now) {
  const live = rows.filter((r) => !isExpired(r, now));
  live.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  return live.slice(Math.max(0, live.length - MAX_SHOWN));
}

// parseTtl(s) -> ms | null. Accepts "7d", "24h", "30m", a bare number of ms,
// or nothing (-> DEFAULT_TTL_MS). Unparseable input -> null (caller refuses).
function parseTtl(s) {
  if (s == null || s === '') return DEFAULT_TTL_MS;
  const str = String(s).trim();
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|s|ms)?$/i.exec(str);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'ms').toLowerCase();
  const mult = { d: DAY_MS, h: 3600000, m: 60000, s: 1000, ms: 1 }[unit];
  return Math.round(n * mult);
}

function utf8ByteLength(s) { return Buffer.byteLength(String(s == null ? '' : s), 'utf8'); }

// checkoutIsAntiHall(cwd) -> true only when <toplevel or cwd>/plugins/anti-hall/
// .claude-plugin/plugin.json exists and its "name" field is literally
// "anti-hall". Walks up from cwd looking for that path (handles a caller
// invoked from a subdirectory of the checkout); no git spawn.
function checkoutIsAntiHall(cwd, fsi) {
  const F = fsi || fs;
  let dir = path.resolve(cwd || process.cwd());
  const root = path.parse(dir).root;
  for (let i = 0; i < 64 && dir && dir !== root; i++) {
    const candidate = path.join(dir, 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json');
    try {
      const parsed = JSON.parse(F.readFileSync(candidate, 'utf8'));
      if (parsed && parsed.name === 'anti-hall') return true;
      return false; // found the file but wrong name -> definitively not anti-hall
    } catch (_) { /* keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// postsInLast24h(rows, now) -> count of rows whose ts falls in [now-24h, now].
function postsInLast24h(rows, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  return rows.filter((r) => Number.isFinite(r.ts) && r.ts > n - DAY_MS && r.ts <= n).length;
}

// post(opts) -> { ok, id?, error?, reason? }
// opts: { home, env, cwd, text, ttl, now, fsi, settingsEnabled }
//   settingsEnabled: injectable override of the devswarm.maintainerNotice.post
//   setting (tests only) — production callers omit it and this reads
//   hooks/lib/settings.js's real value.
function post(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  let settingOn = o.settingsEnabled;
  if (settingOn === undefined) {
    try {
      const settings = require('../../hooks/lib/settings.js');
      settingOn = settings.getWithEnv('devswarm', 'maintainerNotice.post', false, o.env);
    } catch (_) { settingOn = false; }
  }
  if (!settingOn) {
    logEvent('post', 'info', 'refused: setting off', { reason: 'setting-off' });
    return { ok: false, reason: 'setting-off', error: 'devswarm.maintainerNotice.post is off — this is a mistake guard, not authentication; set it (and confirm) only in the anti-hall dev checkout' };
  }

  const isAntiHall = checkoutIsAntiHall(o.cwd, F);
  if (!isAntiHall) {
    logEvent('post', 'info', 'refused: checkout is not anti-hall', { reason: 'wrong-checkout' });
    return { ok: false, reason: 'wrong-checkout', error: 'this checkout\'s plugins/anti-hall/.claude-plugin/plugin.json does not name "anti-hall" — refusing to post (mistake guard, not authentication)' };
  }

  const text = o.text == null ? '' : String(o.text);
  if (!text.trim()) {
    return { ok: false, reason: 'empty-text', error: '--post requires non-empty text' };
  }
  if (utf8ByteLength(text) > MAX_TEXT_BYTES) {
    logEvent('post', 'info', 'refused: text too long', { reason: 'text-too-long', bytes: utf8ByteLength(text) });
    return { ok: false, reason: 'text-too-long', error: 'text exceeds ' + MAX_TEXT_BYTES + ' bytes (got ' + utf8ByteLength(text) + ')' };
  }

  const ttlMs = parseTtl(o.ttl);
  if (ttlMs == null) {
    return { ok: false, reason: 'bad-ttl', error: 'unparseable --ttl: ' + JSON.stringify(o.ttl) };
  }

  const rows = readAllRows(home, F);
  const recentCount = postsInLast24h(rows, now);
  if (recentCount >= MAX_POSTS_PER_DAY) {
    logEvent('post', 'info', 'refused: rate limit', { reason: 'rate-limited', recentCount });
    return { ok: false, reason: 'rate-limited', error: MAX_POSTS_PER_DAY + ' posts per 24h already used (' + recentCount + ')' };
  }

  const id = crypto.randomBytes(8).toString('hex');
  const row = { id, ts: now, expiresAt: now + ttlMs, text };

  try {
    F.mkdirSync(devswarmRoot(home), { recursive: true });
    F.appendFileSync(noticesPath(home), JSON.stringify(row) + '\n');
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) };
  }

  logEvent('post', 'info', 'posted maintainer notice', { id, ttlMs, bytes: utf8ByteLength(text) });
  return { ok: true, id, ts: row.ts, expiresAt: row.expiresAt };
}

// list(opts) -> { ok:true, notices: [{id, ts, expiresAt, text}] } — newest
// MAX_SHOWN unexpired notices, oldest-first. Never mutates the cursor.
function list(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const rows = readAllRows(home, F);
  const shown = unexpiredCapped(rows, now);
  return { ok: true, notices: shown.map((r) => ({ id: r.id, ts: r.ts, expiresAt: r.expiresAt, text: r.text })) };
}

// readCursor(home, repoKey, fsi) -> { lastSeenId } | { lastSeenId: null }
function readCursor(home, repoKey, fsi) {
  const F = fsi || fs;
  try {
    const parsed = JSON.parse(F.readFileSync(cursorPath(home, repoKey), 'utf8'));
    return { lastSeenId: (parsed && typeof parsed.lastSeenId === 'string') ? parsed.lastSeenId : null };
  } catch (_) { return { lastSeenId: null }; }
}

function writeCursor(home, repoKey, cursor, fsi) {
  const F = fsi || fs;
  F.mkdirSync(cursorDir(home), { recursive: true });
  const p = cursorPath(home, repoKey);
  const tmp = p + '.tmp.' + process.pid;
  F.writeFileSync(tmp, JSON.stringify(cursor));
  F.renameSync(tmp, p);
}

// unseenFor(opts) -> { ok, notices } — the unexpired, currently-shown notices
// (same MAX_SHOWN window as list()) this repoKey has not yet been marked as
// having seen. Pure read: never advances the cursor (see markSeen).
function unseenFor(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const repoKey = o.repoKey;
  if (typeof repoKey !== 'string' || !repoKey) return { ok: false, notices: [], error: 'missing repoKey' };

  const rows = readAllRows(home, F);
  const shown = unexpiredCapped(rows, now);
  if (!shown.length) return { ok: true, notices: [] };

  const cursor = readCursor(home, repoKey, F);
  if (!cursor.lastSeenId) return { ok: true, notices: shown };

  const idx = shown.findIndex((r) => r.id === cursor.lastSeenId);
  // Cursor id not among the currently-shown window (e.g. it rolled off the
  // top-5 window, or the cursor references an id from before a gap) -> every
  // currently-shown notice is treated as unseen (fail-open toward SHOWING,
  // never toward silently dropping a real notice).
  const unseen = idx === -1 ? shown : shown.slice(idx + 1);
  return { ok: true, notices: unseen };
}

// markSeen(opts) -> { ok } — advances repoKey's cursor to `id` (monotonic:
// only moves forward through the currently-known row order; a stale/unknown
// id is a no-op). Emits ONE 'seen' metric event per (repoKey, id) the FIRST
// time it is marked (never re-emitted on a later markSeen for the same id).
function markSeen(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const repoKey = o.repoKey;
  const id = o.id;
  if (typeof repoKey !== 'string' || !repoKey || typeof id !== 'string' || !id) {
    return { ok: false, error: 'missing repoKey/id' };
  }

  const rows = readAllRows(home, F);
  const row = rows.find((r) => r.id === id);
  const cursor = readCursor(home, repoKey, F);
  const alreadySeen = cursor.lastSeenId === id;

  try { writeCursor(home, repoKey, { lastSeenId: id }, F); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  if (!alreadySeen) {
    logEvent('seen', 'info', 'maintainer notice seen', {
      id, repoKey, ageMs: row ? Math.max(0, now - (Number(row.ts) || now)) : null,
    });
  }
  return { ok: true };
}

module.exports = {
  MAX_TEXT_BYTES, MAX_POSTS_PER_DAY, MAX_SHOWN, DEFAULT_TTL_MS,
  noticesPath, cursorPath, checkoutIsAntiHall, parseTtl, postsInLast24h,
  unexpiredCapped, readAllRows, readCursor, writeCursor,
  post, list, unseenFor, markSeen,
};
