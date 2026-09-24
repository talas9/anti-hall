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

module.exports = { statePath, read, write, tagFromSessionId, WRITE_INTERVAL_MS, WRITE_MIN_DELTA };
