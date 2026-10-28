// anti-hall :: context-pct — the MAIN THREAD's context-window usage, from the
// best available source, Claude AND Codex.
//
// SOURCES, in preference order:
//
//   1. STATUSLINE (Claude only, real figure). The statusLine renderer
//      receives an authoritative `context_window.{used_percentage,
//      max_tokens}` from Claude Code on every render
//      (statusline/phase-bar.js's contextLine()) — the ONLY place a Claude
//      session's real window size is ever visible at all (verified: no
//      "[1m]"/"context-1m" marker or window-size field was found in any
//      Claude transcript entry or hook payload across a real multi-session
//      sample). statusline/phase-bar.js persists it to
//      hooks/lib/context-pct-store.js on every render (throttled); this file
//      prefers that reading whenever it's fresh (FRESH_MS, 10 minutes).
//
//   2. CODEX ROLLOUT (real figure, when the transcript is a Codex rollout).
//      UNLIKE Claude, a Codex rollout file DOES record the exact window size
//      inline: an `event_msg` entry whose `payload.type === "token_count"`
//      carries `payload.info.{total_token_usage.total_tokens,
//      model_context_window}` (verified against a real
//      ~/.codex/sessions/**/rollout-*.jsonl — see findLastCodexTokenCount()).
//      This is a REAL reading, not an estimate, whenever present — better
//      than Claude's own transcript, which never records this at all.
//
//   3. CLAUDE TRANSCRIPT ESTIMATE (fallback, when neither of the above is
//      available — no statusline installed/recently rendered AND this is not
//      a Codex rollout). The last MAIN-THREAD (isSidechain !== true)
//      assistant transcript entry carries an Anthropic `usage` block;
//      `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
//      divided by a window size gives an approximate percentage. Window size,
//      in order:
//        a. ANTIHALL_CONTEXT_WINDOW_TOKENS (explicit override, always wins)
//        b. the STICKY last-known statusline max_tokens for this session
//           (hooks/lib/context-pct-store.js's readSticky() — kept regardless
//           of the 10-minute freshness cutoff: the window size does not
//           change mid-session just because the statusline stopped
//           rendering, e.g. an idle gap)
//        c. the INFERRED-1M latch: observed usage this call, or at any
//           earlier point this session, exceeding 200000 PROVES the window
//           isn't 200k (evidence, not a guess — see windowLabel:'inferred-1m')
//        d. UNKNOWN: falls back to 200000 but `windowKnown: false` — callers
//           MUST NOT fire a mandatory directive from an unknown-window
//           estimate (it could be badly wrong on an undetected 1M session),
//           only a soft advisory.
//
// FAIL-OPEN: any missing/unreadable/malformed transcript, or an entry
// lacking a usable usage block, with no fresh statusline reading either,
// returns null. Never throws.
//
// Pure Node built-ins only.

'use strict';

const os = require('os');
const store = require('./context-pct-store.js');
const tail = require('./transcript-tail.js');

const DEFAULT_MAX_TOKENS = 200000;
const INFERRED_MAX_TOKENS = 1000000;
const FRESH_MS = 10 * 60 * 1000;

// findLastAssistantUsage(lines) -> { input, cacheCreate, cacheRead } | null
// Scans backward through the given lines for the most recent main-thread
// (Claude-shaped) assistant entry that carries a usage block.
function findLastAssistantUsage(lines) {
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
  return null;
}

// findLastCodexTokenCount(lines) -> { used, max } | null. Scans backward for
// the most recent Codex rollout `event_msg` / `token_count` entry, which
// carries the REAL window size (payload.info.model_context_window) alongside
// cumulative usage (payload.info.total_token_usage.total_tokens).
function findLastCodexTokenCount(lines) {
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('token_count') === -1) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || e.type !== 'event_msg') continue;
    const payload = e.payload;
    if (!payload || payload.type !== 'token_count') continue;
    const info = payload.info;
    if (!info || typeof info !== 'object') continue;
    const used = info.total_token_usage && typeof info.total_token_usage.total_tokens === 'number'
      ? info.total_token_usage.total_tokens : null;
    const max = typeof info.model_context_window === 'number' ? info.model_context_window : null;
    if (used === null || max === null || max <= 0) continue;
    return { used, max };
  }
  return null;
}

// readTailLines(transcriptPath, opts) -> string[] | null. Uses opts.lines
// when the caller already did one shared read (hooks/auto-handover-pause-nag.js);
// otherwise reads its own capped tail.
function readTailLines(transcriptPath, opts) {
  if (opts && Array.isArray(opts.lines)) return opts.lines;
  return tail.readTail(transcriptPath, opts && opts.maxTailBytes);
}

// getContextPct(transcriptPath, env, opts) -> {
//   pct, used, max, source, estimated, windowKnown, windowLabel
// } | null.
//   opts.home        : home dir for the statusline-bridge lookup (tests; default os.homedir())
//   opts.sessionId    : the CURRENT hook payload's session_id — MUST be the raw
//                       session_id (see hooks/lib/context-pct-store.js's tagFromSessionId).
//   opts.lines        : a pre-read tail (string[]) — skips this file's own read
//                       when the caller already shares one (pause-nag.js).
//   source            : 'statusline' | 'codex-transcript' | 'estimate'
//   estimated         : true only for the 'estimate' source
//   windowKnown       : true for every source except an 'estimate' whose
//                       window size fell all the way through to the
//                       200k-unknown default (windowLabel:'default') — callers
//                       must not treat that case as mandatory-fire-worthy.
//   windowLabel       : 'env' | 'sticky' | 'inferred-1m' | 'default' (estimate only)
// Fail-open: null on anything unusable. `env` is injectable for tests.
function getContextPct(transcriptPath, env, opts) {
  try {
    const e = env || process.env;
    const o = opts || {};
    const home = o.home || os.homedir();

    const tagForBridge = store.tagFromSessionId(o.sessionId);
    if (tagForBridge) {
      const persisted = store.read(home, tagForBridge, FRESH_MS);
      if (persisted) {
        return {
          pct: persisted.pct, used: persisted.usedTokens, max: persisted.maxTokens,
          source: 'statusline', estimated: false, windowKnown: true, windowLabel: null,
        };
      }
    }

    const lines = readTailLines(transcriptPath, o);
    if (!lines) return null;

    const codex = findLastCodexTokenCount(lines);
    if (codex) {
      const pct = Math.max(0, Math.min(100, (codex.used / codex.max) * 100));
      return {
        pct, used: codex.used, max: codex.max,
        source: 'codex-transcript', estimated: false, windowKnown: true, windowLabel: null,
      };
    }

    const usage = findLastAssistantUsage(lines);
    if (!usage) return null;
    const used = usage.input + usage.cacheCreate + usage.cacheRead;

    let max;
    let windowLabel;
    let windowKnown = true;
    const envMax = parseInt(e.ANTIHALL_CONTEXT_WINDOW_TOKENS, 10);
    if (Number.isFinite(envMax) && envMax > 0) {
      max = envMax;
      windowLabel = 'env';
    } else {
      const sticky = tagForBridge ? store.readSticky(home, tagForBridge) : null;
      const alreadyInferred = tagForBridge ? store.readInferred1m(home, tagForBridge) : false;
      const overStandard = used > DEFAULT_MAX_TOKENS;
      if (sticky && Number.isFinite(sticky.maxTokens) && sticky.maxTokens > 0) {
        // A REAL max_tokens the statusline saw earlier this session — kept
        // regardless of the 10-min freshness cutoff (an idle gap doesn't
        // change the window size). Still the most trustworthy fallback.
        max = sticky.maxTokens;
        windowLabel = 'sticky';
      } else if (overStandard || alreadyInferred) {
        max = INFERRED_MAX_TOKENS;
        windowLabel = 'inferred-1m';
        if (overStandard && tagForBridge) store.writeInferred1m(home, tagForBridge);
      } else {
        max = DEFAULT_MAX_TOKENS;
        windowLabel = 'default';
        windowKnown = false; // genuinely unknown — caller must not fire mandatory
      }
    }

    const pct = Math.max(0, Math.min(100, (used / max) * 100));
    return { pct, used, max, source: 'estimate', estimated: true, windowKnown, windowLabel };
  } catch (_) {
    return null;
  }
}

module.exports = {
  getContextPct, findLastAssistantUsage, findLastCodexTokenCount,
  DEFAULT_MAX_TOKENS, INFERRED_MAX_TOKENS, FRESH_MS,
};
