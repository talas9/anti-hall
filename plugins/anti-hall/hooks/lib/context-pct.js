// anti-hall :: context-pct — the MAIN THREAD's context-window usage, from the
// best available source.
//
// TWO SOURCES, in preference order:
//
//   1. STATUSLINE (real figure). The statusLine renderer receives an
//      authoritative `context_window.{used_percentage, max_tokens}` from
//      Claude Code on every render (statusline/phase-bar.js's contextLine()),
//      correct for a 1M-context session as much as the standard 200k one —
//      this is the ONLY place that size is ever actually known, since it is
//      never echoed into a transcript entry or a hook payload (verified: no
//      transcript entry across a real multi-session sample carries a "1m"/
//      "context-1m" marker or any window-size field — see git history for
//      the investigation this superseded). statusline/phase-bar.js persists
//      it to hooks/lib/context-pct-store.js on every render (throttled); this
//      file prefers that reading whenever it's fresh (FRESH_MS, 10 minutes).
//
//   2. TRANSCRIPT ESTIMATE (fallback, when source 1 is absent/stale — no
//      statusline installed, or none rendered recently). The last MAIN-THREAD
//      (isSidechain !== true) assistant transcript entry carries an Anthropic
//      `usage` block; `input_tokens + cache_creation_input_tokens +
//      cache_read_input_tokens` divided by an assumed window size gives an
//      approximate percentage. The window size itself is NOT guessed from the
//      model id (see the investigation note above) — it is
//      ANTIHALL_CONTEXT_WINDOW_TOKENS if set, else the standard 200000. This
//      path is a genuine ESTIMATE and callers should label it as such (see
//      the `estimated` flag) — on a 1M-context session with no statusline
//      installed, it will overstate the real percentage.
//
// FAIL-OPEN: any missing/unreadable/malformed transcript, or an entry lacking
// a usable usage block, with no fresh statusline reading either, returns
// null. Never throws.
//
// Pure Node built-ins only.

'use strict';

const fs = require('fs');
const os = require('os');
const store = require('./context-pct-store.js');

const DEFAULT_MAX_TOKENS = 200000;
const FRESH_MS = 10 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const TAIL_BYTES_WIDE = 4 * 1024 * 1024;

// readTailLines(transcriptPath, bytes) -> string[] | null. Reads the last
// `bytes` of the file, splits into lines, and drops a possibly-partial first
// line when the file is larger than the requested tail.
function readTailLines(transcriptPath, bytes) {
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= 0) return null;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fd = fs.openSync(transcriptPath, 'r');
    const got = fs.readSync(fd, buf, 0, n, size - n);
    let lines = buf.toString('utf8', 0, got).split('\n');
    if (size > n) lines = lines.slice(1); // first line may be partial
    return lines;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
  }
}

// findLastAssistantUsage(transcriptPath) -> { input, cacheCreate, cacheRead } | null
// Scans backward through the tail for the most recent main-thread assistant
// entry that carries a usage block. Widens the tail once (4MB) if the smaller
// tail holds no such entry at all, so a very chatty recent turn (large tool
// outputs) does not push the last usage block out of range.
function findLastAssistantUsage(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  for (const bytes of [TAIL_BYTES, TAIL_BYTES_WIDE]) {
    const lines = readTailLines(transcriptPath, bytes);
    if (!lines) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.indexOf('"usage"') === -1) continue;
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e || typeof e !== 'object' || e.type !== 'assistant') continue;
      if (e.isSidechain === true) continue; // subagent turn, not the main thread
      const usage = e.message && e.message.usage;
      if (!usage || typeof usage !== 'object') continue;
      const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const cacheCreate = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
      const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
      if (input === 0 && cacheCreate === 0 && cacheRead === 0) continue; // unusable/empty usage
      return { input, cacheCreate, cacheRead };
    }
  }
  return null;
}

// getContextPct(transcriptPath, env, opts) -> { pct, used, max, source, estimated } | null.
//   opts.home      : home dir for the statusline-bridge lookup (tests; default os.homedir())
//   opts.sessionId : the CURRENT hook payload's session_id — MUST be the raw
//                    session_id (not a fallback hash): the statusline bridge is
//                    keyed by session_id alone so the writer (statusline) and
//                    reader (this file) always agree on the same tag.
//   source: 'statusline' (real figure, fresh) | 'estimate' (transcript-derived)
//   estimated: true only for the 'estimate' source — callers should label
//              messages built from it accordingly.
// Fail-open: null on anything unusable. `env` is injectable for tests.
function getContextPct(transcriptPath, env, opts) {
  try {
    const e = env || process.env;
    const o = opts || {};
    const home = o.home || os.homedir();

    const tag = store.tagFromSessionId(o.sessionId);
    if (tag) {
      const persisted = store.read(home, tag, FRESH_MS);
      if (persisted) {
        return { pct: persisted.pct, used: persisted.usedTokens, max: persisted.maxTokens, source: 'statusline', estimated: false };
      }
    }

    const usage = findLastAssistantUsage(transcriptPath);
    if (!usage) return null;
    const used = usage.input + usage.cacheCreate + usage.cacheRead;
    let max = parseInt(e.ANTIHALL_CONTEXT_WINDOW_TOKENS, 10);
    if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX_TOKENS;
    const pct = Math.max(0, Math.min(100, (used / max) * 100));
    return { pct, used, max, source: 'estimate', estimated: true };
  } catch (_) {
    return null;
  }
}

module.exports = { getContextPct, findLastAssistantUsage, DEFAULT_MAX_TOKENS, FRESH_MS };
