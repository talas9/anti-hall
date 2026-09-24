// anti-hall :: context-pct-store — the harness's OWN context-window figure,
// bridged from the (optional, install-time) statusline renderer to hooks.
//
// WHY: the statusline receives an authoritative `context_window.
// {used_percentage, used_tokens, max_tokens}` from Claude Code on every
// render (statusline/phase-bar.js's contextLine(), tests/statusline/*.test.js
// fixtures) — this is the REAL context-window size, correct for a 1M-context
// session as much as the standard 200k one. Hooks never see this JSON
// directly (it's only piped to the statusLine command), so
// statusline/phase-bar.js persists it here on every render (throttled — see
// shouldWrite()), and hooks/lib/context-pct.js reads it back, preferring it
// over the transcript-usage estimate whenever it's fresh.
//
// STATE: <home>/.anti-hall/context-pct/<tag>.json -> { pct, usedTokens, maxTokens, ts }
// tag: same scheme as hooks/lib/auto-handover-state.js's sessionTag (prefer
// session_id, else a hash) — statusline/phase-bar.js's OWN currentSessionTag()
// already derives this identically from the statusline's stdin session_id.
//
// THROTTLE: write() skips unless at least WRITE_INTERVAL_MS has passed since
// the last write OR the percent moved by >= WRITE_MIN_DELTA points — keeps
// the statusline's own per-render cost negligible (one small atomic write at
// most every 30s under a stable context, immediately on a real jump).
//
// FRESHNESS: read() returns null (fall through to the transcript estimate)
// when the file is older than maxAgeMs (callers use ~10 minutes) — a stale
// reading (no statusline render recently, or none installed at all) must
// never be trusted as current.
//
// FAIL-OPEN: any read/write error is swallowed; a write failure never
// surfaces to the statusline (which must never crash), a read failure just
// falls through to the transcript-based estimate.
//
// Pure Node built-ins only.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WRITE_INTERVAL_MS = 30 * 1000;
const WRITE_MIN_DELTA = 1;

function statePath(home, tag) {
  return path.join(home, '.anti-hall', 'context-pct', tag + '.json');
}

// tagFromSessionId(sessionId) -> sanitized tag | null. DELIBERATELY
// session_id-ONLY (no cwd/transcript-path hash fallback like
// auto-handover-state.js's sessionTag or phase-bar.js's currentSessionTag):
// the WRITER (statusline, this session's JSON) and the READER (a hook,
// a DIFFERENT stdin envelope) must derive the exact same tag for the same
// session, and session_id is the one field both envelopes are documented to
// carry. Falling back to a cwd/transcript-path hash risks the two sides
// picking DIFFERENT tags for the same session (statusline stdin has no
// documented transcript_path field) and silently never matching up. Absent
// session_id -> null -> caller skips persistence/lookup entirely (fail-open
// to the transcript estimate, never a wrong cross-session read).
function tagFromSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const safe = sessionId.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return safe || null;
}

function readRaw(home, tag) {
  try {
    const obj = JSON.parse(fs.readFileSync(statePath(home, tag), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (_) {
    return null;
  }
}

// read(home, tag, maxAgeMs) -> { pct, usedTokens, maxTokens, ts } | null.
// null when absent, malformed, or older than maxAgeMs.
function read(home, tag, maxAgeMs) {
  if (!tag) return null;
  const raw = readRaw(home, tag);
  if (!raw || typeof raw.pct !== 'number' || !Number.isFinite(raw.pct)) return null;
  const ts = typeof raw.ts === 'number' ? raw.ts : 0;
  if (!ts || (Date.now() - ts) > maxAgeMs) return null;
  return {
    pct: raw.pct,
    usedTokens: typeof raw.usedTokens === 'number' ? raw.usedTokens : null,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : null,
    ts,
  };
}

// readSticky(home, tag) -> { maxTokens, ts } | null. Like read(), but IGNORES
// the freshness cutoff — only maxTokens needs to be present and numeric. The
// window size a statusline last reported does not change mid-session just
// because the statusline stopped rendering (an idle gap); hooks/lib/
// context-pct.js's transcript-estimate fallback uses this as a REAL, sticky
// lower-risk substitute for its own 200k-default guess.
function readSticky(home, tag) {
  if (!tag) return null;
  const raw = readRaw(home, tag);
  if (!raw || typeof raw.maxTokens !== 'number' || !Number.isFinite(raw.maxTokens) || raw.maxTokens <= 0) return null;
  return { maxTokens: raw.maxTokens, ts: typeof raw.ts === 'number' ? raw.ts : null };
}

// write(home, tag, { pct, usedTokens, maxTokens }, now) — throttled, atomic,
// best-effort. Returns true if it actually wrote, false if throttled/failed.
function write(home, tag, data, now) {
  if (!tag || !data || typeof data.pct !== 'number' || !Number.isFinite(data.pct)) return false;
  const nowTs = Number.isFinite(now) ? now : Date.now();
  try {
    const prev = readRaw(home, tag);
    if (prev && typeof prev.ts === 'number' && typeof prev.pct === 'number') {
      const age = nowTs - prev.ts;
      const delta = Math.abs(data.pct - prev.pct);
      if (age < WRITE_INTERVAL_MS && delta < WRITE_MIN_DELTA) return false; // throttled
    }
    const p = statePath(home, tag);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const out = {
      pct: data.pct,
      usedTokens: typeof data.usedTokens === 'number' ? data.usedTokens : null,
      maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : null,
      ts: nowTs,
    };
    const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false; // fail-open: a statusline write must never surface
  }
}

// --- Inferred-1M-window latch (transcript-estimate fallback ONLY) ----------
// A separate file/path from the statusline bridge above (never touched by
// statusline/phase-bar.js's write()) — owned by hooks/lib/context-pct.js's
// estimate path: when the observed main-thread token usage for a session
// ever exceeds the standard 200k window, the window CANNOT be 200k, so the
// rest of that session's estimate treats it as 1,000,000 instead. Latched so
// a later turn whose usage happens to read back under 200k (a fresh
// transcript segment, a momentary dip) doesn't flip back to the wrong
// window. Cleared only by a fresh session (a new tag) — there is no
// re-arm/expiry, matching "for the session" in the spec.

function inferredPath(home, tag) {
  return path.join(home, '.anti-hall', 'context-pct', tag + '.inferred-1m.json');
}

// readInferred1m(home, tag) -> true | false. Fail-open: false on any error
// (never blocks the estimate; worst case it re-detects on the next call that
// actually exceeds 200k again).
function readInferred1m(home, tag) {
  if (!tag) return false;
  try {
    const obj = JSON.parse(fs.readFileSync(inferredPath(home, tag), 'utf8'));
    return !!(obj && obj.inferred === true);
  } catch (_) {
    return false;
  }
}

// writeInferred1m(home, tag) — best-effort, idempotent, atomic.
function writeInferred1m(home, tag) {
  if (!tag) return;
  try {
    const p = inferredPath(home, tag);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ inferred: true, ts: Date.now() }));
    fs.renameSync(tmp, p);
  } catch (_) {
    /* best-effort */
  }
}

module.exports = {
  statePath, read, readSticky, write, tagFromSessionId, WRITE_INTERVAL_MS, WRITE_MIN_DELTA,
  inferredPath, readInferred1m, writeInferred1m,
};
