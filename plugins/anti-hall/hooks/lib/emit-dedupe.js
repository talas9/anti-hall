// anti-hall :: emit-dedupe — per-session suppression of repeated hook blocks.
//
// ROOT CAUSE this addresses: when prompts queue while the session is busy (cron
// ticks, queued user messages), Claude Code runs UserPromptSubmit AT ENQUEUE
// TIME, once per queued prompt, then delivers all of them together — so every
// hook's identical block repeats N times in one delivered turn. Field bursts
// span a median 26s / p90 48s / max 137s, so a fixed time window cannot
// collapse them; consumption must be read from the transcript. Separately, a
// few DevSwarm segments (WORKSPACES table, ORPHANED MESH banner) were
// re-emitted every turn even when only volatile ages changed.
//
// CONSUMPTION SIGNAL (verified on a field transcript, 694 UPS attachments):
// Claude Code writes a hook's additionalContext to the transcript as an
// `attachment` entry of type `hook_additional_context` / hookEvent
// `UserPromptSubmit` ONLY WHEN THE PROMPT IS DELIVERED, stamped with the hook's
// own (enqueue-time) timestamp. An assistant entry after the emit is NOT a
// consumption signal: in 251/694 cases the busy turn kept writing assistant
// entries (up to 45s later) BEFORE the queued prompt's attachments landed. So:
//   - a copy emitted at T is CONSUMED once the transcript tail holds a UPS
//     hook_additional_context attachment with timestamp >= T - TS_TOLERANCE_MS
//     whose content element IS that exact string (or holds it as whole
//     '\n\n'-delimited segments) — compared by sha1, never by prefix (214/214
//     field VERIFY-FIRST elements were the hook's additionalContext verbatim);
//   - the prompt of an earlier invocation at S was DELIVERED once any UPS
//     hook_additional_context attachment with timestamp >= S - tolerance exists.
//
// Rules, keyed per session + per block key:
//   (a) PENDING (every key): same content hash as the last emit AND that emit is
//       not yet consumed -> suppress (collapses a queued burst to one copy,
//       however long it spans). A copy pending longer than maxPendingMs (10 min,
//       e.g. a queued prompt the user cancelled) is re-emitted.
//   (b) ON-CHANGE (keys passed keepaliveTurns > 0): consumed + same NORMALIZED
//       hash -> suppress, but re-emit after `keepaliveTurns` suppressed DELIVERED
//       turns. A changed hash -> emit.
//   Fallback when the transcript is missing/unreadable/has no timestamps: the
//   old 15s window guard (same hash within windowMs -> suppress). Missing
//   session id -> emit.
//   CONTEXT LOSS: a record counts only for the transcript it was emitted into
//   (transcript_path hash), and only if emitted after the session's last reset
//   marker (hooks/emit-dedupe-reset.js on every SessionStart source:
//   startup/resume/clear/compact) — otherwise it is treated as absent.
//
// FAIL-OPEN: any other error -> emit. Kill switch: ANTIHALL_EMIT_DEDUPE=0.
//
// State: <home>/.anti-hall/emit-dedupe/dedupe-<sessionId>.json, a map
//   key -> { hash, tp, ch, k, lastEmittedAt, lastSeenAt, turnsSinceEmit }
//   '__reset' -> { resetAt, lastSeenAt }
// (hash = normalized-content sha1; ch/k = exact-content sha1 + segment count;
// tp = transcript_path sha1 prefix — no content text is stored)
// written atomically (unique tmp + rename) after re-reading and merging only
// this key. Keys unseen for 24h are pruned on write; idle session files are
// swept (throttled) by lib/state-prune.js. Pure Node built-ins.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_WINDOW_MS = 15000;
const DEFAULT_KEEPALIVE_TURNS = 10;
const DEFAULT_MAX_PENDING_MS = 10 * 60 * 1000;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const TS_TOLERANCE_MS = 1000;
const TAIL_BYTES = 256 * 1024;
const TAIL_BYTES_WIDE = 4 * 1024 * 1024;
const SEP = '\n\n'; // how hooks join their segments into one additionalContext
const RESET_KEY = '__reset';
const PREFIX = 'dedupe';

function stateDir(home) {
  return path.join(home, '.anti-hall', 'emit-dedupe');
}

function statePath(home, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return path.join(stateDir(home), PREFIX + '-' + safe + '.json');
}

function readState(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

function hashOf(content, normalize) {
  let s = content == null ? '' : String(content);
  if (typeof normalize === 'function') s = String(normalize(s));
  return crypto.createHash('sha1').update(s).digest('hex');
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

// exactId(content) -> { ch, k }: hash of the EXACT emitted string (never the
// text itself) + its segment count, for exact-match consumption checks.
function exactId(content) {
  const s = String(content == null ? '' : content);
  return { ch: sha1(s), k: s.split(SEP).length };
}

// tpId(transcriptPath) -> short hash | null. A record only counts for the
// transcript it was emitted into (/clear or a rotated transcript = new context).
function tpId(transcriptPath) {
  return transcriptPath && typeof transcriptPath === 'string' ? sha1(transcriptPath).slice(0, 16) : null;
}

// matchesExact(els, ch, k) -> bool. True when some attachment content element
// IS the emitted string, or holds it as a run of k whole SEP-delimited segments
// (a hook that joins several blocks into one additionalContext, e.g.
// devswarm-parent-inbox.js). Hash comparison only; a mere prefix never matches.
function matchesExact(els, ch, k) {
  for (const el of els) {
    if (sha1(el) === ch) return true;
    const pieces = el.split(SEP);
    for (let i = 0; i + k <= pieces.length; i++) {
      if (sha1(pieces.slice(i, i + k).join(SEP)) === ch) return true;
    }
  }
  return false;
}

function disabled(env) {
  return !!env && env.ANTIHALL_EMIT_DEDUPE === '0';
}

// scanTail(transcriptPath, bytes) -> { atts: [{ts, els}], size } | null.
// atts = UPS hook_additional_context attachments in the last `bytes` of the
// transcript. null = unusable (missing/unreadable, no complete line, or no
// timestamp anywhere in the tail) -> caller falls back. Memoized per process
// (one hook may check several keys against the same transcript).
const _memo = new Map();
function scanTail(transcriptPath, bytes) {
  const mk = transcriptPath + '\0' + bytes;
  if (_memo.has(mk)) return _memo.get(mk);
  let result = null;
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fd = fs.openSync(transcriptPath, 'r');
    const got = fs.readSync(fd, buf, 0, n, size - n);
    let lines = buf.toString('utf8', 0, got).split('\n');
    if (size > n) lines = lines.slice(1); // first line is partial
    const atts = [];
    let anyTs = false;
    for (const line of lines) {
      if (!line) continue;
      if (!anyTs && line.indexOf('"timestamp"') !== -1) anyTs = true;
      if (line.indexOf('hook_additional_context') === -1) continue;
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; }
      const a = e && e.type === 'attachment' ? e.attachment : null;
      if (!a || a.type !== 'hook_additional_context' || a.hookEvent !== 'UserPromptSubmit') continue;
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts)) continue;
      const els = Array.isArray(a.content) ? a.content.map((x) => String(x)) : [String(a.content == null ? '' : a.content)];
      atts.push({ ts, els });
    }
    result = anyTs ? { atts, size } : null;
  } catch (_) {
    result = null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  _memo.set(mk, result);
  return result;
}

// findInTail(transcriptPath, pred) -> true | false | null (unknown). Searches
// the 256KB tail, widening once to 4MB when not found in a larger file. A tail
// holding NO UPS attachment at all is "unknown", not "pending": a harness build
// that never records hook attachments must not silence blocks for maxPendingMs.
function findInTail(transcriptPath, pred) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const t = scanTail(transcriptPath, TAIL_BYTES);
  if (!t) return null;
  if (t.atts.some(pred)) return true;
  let any = t.atts.length > 0;
  if (t.size > TAIL_BYTES) {
    const w = scanTail(transcriptPath, TAIL_BYTES_WIDE);
    if (w) {
      if (w.atts.some(pred)) return true;
      any = any || w.atts.length > 0;
    }
  }
  return any ? false : null;
}

// writeEntry — merge one key into the session file (re-read right before the
// write), prune keys unseen for KEY_TTL_MS, atomic tmp+rename. Best-effort.
function writeEntry(home, sessionId, key, entry, now) {
  const p = statePath(home, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const state = readState(p);
  state[key] = entry;
  for (const k of Object.keys(state)) {
    const e = state[k];
    const seen = e && Number.isFinite(e.lastSeenAt) ? e.lastSeenAt : 0;
    if (now - seen > KEY_TTL_MS) delete state[k];
  }
  const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, p);
  try {
    require('./state-prune.js').pruneStale({ stateDir: path.dirname(p), prefix: PREFIX, keepFile: p });
  } catch (_) {}
}

// shouldEmit(opts) -> boolean. Decides AND records. opts:
//   home, sessionId, key, content      required (missing sessionId -> true)
//   transcriptPath  the hook payload's transcript_path (consumption signal)
//   keepaliveTurns  0/absent = pending-only (rule a); >0 = on-change (rule b)
//   normalize       optional (string) -> string applied before hashing
//   windowMs        fallback window when the transcript is unusable (15000)
//   maxPendingMs    re-emit a copy pending longer than this (600000)
//   now, env        injectable for tests (default Date.now(), process.env)
function shouldEmit(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    if (disabled(env)) return true;
    if (!o.sessionId || !o.key) return true;
    const home = o.home || os.homedir();
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const windowMs = Number.isFinite(o.windowMs) ? o.windowMs : DEFAULT_WINDOW_MS;
    const maxPendingMs = Number.isFinite(o.maxPendingMs) ? o.maxPendingMs : DEFAULT_MAX_PENDING_MS;
    const keepalive = Number.isFinite(o.keepaliveTurns) && o.keepaliveTurns > 0 ? o.keepaliveTurns : 0;
    const hash = hashOf(o.content, o.normalize);
    const key = String(o.key);

    const tp = tpId(o.transcriptPath);
    const state = readState(statePath(home, o.sessionId));
    const prev = state[key];
    // Context-loss reset (SessionStart startup/resume/clear/compact, written by
    // hooks/emit-dedupe-reset.js): a record emitted before the reset was never
    // seen by the current context -> treat as absent. Same for a record emitted
    // into a different transcript.
    const resetAt = state[RESET_KEY] && Number.isFinite(state[RESET_KEY].resetAt) ? state[RESET_KEY].resetAt : 0;
    const prevOk = prev && typeof prev.hash === 'string' &&
      Number.isFinite(prev.lastEmittedAt) && prev.lastEmittedAt <= now &&
      prev.lastEmittedAt >= resetAt && (prev.tp || null) === tp;
    const same = prevOk && prev.hash === hash;
    const lastSeen = prevOk && Number.isFinite(prev.lastSeenAt) ? prev.lastSeenAt : 0;
    const turns = prevOk && Number.isFinite(prev.turnsSinceEmit) ? prev.turnsSinceEmit : 0;

    let emit = true;
    let nextTurns = 0;
    if (same) {
      const since = prev.lastEmittedAt - TS_TOLERANCE_MS;
      const ch = typeof prev.ch === 'string' ? prev.ch : '';
      const k = Number.isFinite(prev.k) && prev.k > 0 ? prev.k : 1;
      const consumed = findInTail(o.transcriptPath,
        (a) => a.ts >= since && !!ch && matchesExact(a.els, ch, k));
      if (consumed === null) {
        // Transcript unusable -> secondary window guard (legacy behavior).
        if ((now - prev.lastEmittedAt) < windowMs) {
          emit = false; nextTurns = turns;
        } else if (keepalive > 0) {
          const newTurn = (now - lastSeen) >= windowMs;
          if (!(newTurn && turns >= keepalive)) { emit = false; nextTurns = turns + (newTurn ? 1 : 0); }
        }
      } else if (!consumed) {
        // Rule (a): the earlier copy is still waiting in the same delivery.
        if ((now - prev.lastEmittedAt) < maxPendingMs) { emit = false; nextTurns = turns; }
      } else if (keepalive > 0) {
        // Rule (b): count only DELIVERED turns (the previous invocation's
        // prompt reached the model) toward the keepalive.
        const newTurn = findInTail(o.transcriptPath, (a) => a.ts >= lastSeen - TS_TOLERANCE_MS) === true;
        const t = turns + (newTurn ? 1 : 0);
        if (t > keepalive) {
          emit = true; // keepalive
        } else {
          emit = false; nextTurns = t;
        }
      }
      // consumed + window-only key -> emit (a new delivered turn).
    }

    try {
      writeEntry(home, o.sessionId, key, emit
        ? Object.assign({ hash, tp, lastEmittedAt: now, lastSeenAt: now, turnsSinceEmit: 0 }, exactId(o.content))
        : { hash: prev.hash, tp: prev.tp || null, ch: prev.ch, k: prev.k,
          lastEmittedAt: prev.lastEmittedAt, lastSeenAt: now, turnsSinceEmit: nextTurns },
      now);
    } catch (_) {
      return true; // cannot persist -> never suppress on unverifiable state
    }
    return emit;
  } catch (_) {
    return true;
  }
}

// record(opts) — unconditionally record an emit (for a block the caller emits
// regardless, so later lookalikes still pending are suppressed). Fail-open.
function record(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    if (disabled(env) || !o.sessionId || !o.key) return;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    writeEntry(o.home || os.homedir(), o.sessionId, String(o.key), Object.assign({
      hash: hashOf(o.content, o.normalize), tp: tpId(o.transcriptPath),
      lastEmittedAt: now, lastSeenAt: now, turnsSinceEmit: 0,
    }, exactId(o.content)), now);
  } catch (_) {}
}

// resetSession({home, sessionId, now, env}) — mark a context loss for this
// session (SessionStart: startup/resume/clear/compact). Every record emitted
// before `resetAt` is then treated as absent, so the next invocation re-emits
// even an unchanged block. Fail-open, never throws.
function resetSession(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    if (disabled(env) || !o.sessionId) return;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    writeEntry(o.home || os.homedir(), o.sessionId, RESET_KEY, { resetAt: now, lastSeenAt: now }, now);
  } catch (_) {}
}

// _resetMemo — tests only: the tail scan is memoized per process.
function _resetMemo() { _memo.clear(); }

module.exports = {
  shouldEmit, record, resetSession, statePath, hashOf, _resetMemo,
  DEFAULT_WINDOW_MS, DEFAULT_KEEPALIVE_TURNS, DEFAULT_MAX_PENDING_MS,
};
