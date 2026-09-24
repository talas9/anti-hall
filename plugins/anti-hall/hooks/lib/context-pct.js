// anti-hall :: context-pct — estimate the MAIN THREAD's context-window usage
// from the transcript, with no dependency on the (optional, install-time)
// statusline being configured.
//
// WHY NOT THE STATUSLINE: Claude Code's statusLine renderer DOES receive an
// authoritative `context_window.used_percentage` (see
// statusline/phase-bar.js's contextLine()), but (a) the statusline is an
// opt-in install (plugins/anti-hall/skills/install-statusline), so a session
// without it has no signal at all, and (b) bridging that value into a hook
// would mean writing a state file on every statusline render (a latency-
// sensitive path, statusline/statusline.js's own header documents a <3s
// watchdog) from up to four separate renderer files just to read it back
// here. Computing directly from the transcript's own recorded token usage is
// self-contained, needs no cross-file wiring, and works whether or not a
// statusline is installed.
//
// METHOD: the last MAIN-THREAD (isSidechain !== true) assistant transcript
// entry carries an Anthropic `usage` block; `input_tokens +
// cache_creation_input_tokens + cache_read_input_tokens` is the same
// "tokens sent to the model on the last turn" figure the harness itself uses
// to derive context-window pressure. Divided by an assumed context-window
// size (default 200000 — the standard, non-1M Claude context; override via
// ANTIHALL_CONTEXT_WINDOW_TOKENS for a 1M-context session) this gives an
// approximate but directionally-correct percentage. This is an ESTIMATE, not
// the harness's own figure — it can read a few points off in either
// direction depending on system-prompt/tool-schema overhead the harness
// counts that a plain token sum does not.
//
// FAIL-OPEN: any missing/unreadable/malformed transcript, or an entry
// lacking a usable usage block, returns null. Never throws.
//
// Pure Node built-ins only.

'use strict';

const fs = require('fs');

const DEFAULT_MAX_TOKENS = 200000;
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

// getContextPct(transcriptPath, env) -> { pct, used, max } | null. Fail-open:
// null on anything unusable. `env` is injectable for tests (default
// process.env).
function getContextPct(transcriptPath, env) {
  try {
    const e = env || process.env;
    const usage = findLastAssistantUsage(transcriptPath);
    if (!usage) return null;
    const used = usage.input + usage.cacheCreate + usage.cacheRead;
    let max = parseInt(e.ANTIHALL_CONTEXT_WINDOW_TOKENS, 10);
    if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX_TOKENS;
    const pct = Math.max(0, Math.min(100, (used / max) * 100));
    return { pct, used, max };
  } catch (_) {
    return null;
  }
}

module.exports = { getContextPct, findLastAssistantUsage, DEFAULT_MAX_TOKENS };
