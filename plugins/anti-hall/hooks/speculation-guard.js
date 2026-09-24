#!/usr/bin/env node
// anti-hall :: speculation-guard (Stop hook, loop-safe)
//
// Fires on Stop. Reads the transcript, extracts the LAST assistant message,
// scans it for speculation markers (hedge words that assert without evidence),
// and blocks ONCE if speculation markers are present and the message contains
// no evidence/uncertainty acknowledgment that would make the hedging honest.
//
// DECISION LOGIC:
//   speculation markers present AND no acknowledgment -> BLOCK (once per hash)
//   speculation markers present AND acknowledgment present -> ALLOW
//   no speculation markers -> ALLOW
//   any parse/read error -> ALLOW (fail-open)
//
// LOOP-SAFE: hashes the last-message text. Stores the blocked hash in
//   ~/.anti-hall/speculation-guard-state-<session>.json
//   If the same hash was already blocked (nothing changed), allow exit 0 so the
//   nudge fires ONCE per distinct speculative message, never wedges.
//
// FAIL-OPEN: any error -> exit 0, no block, no stderr noise.
//
// JEV (OPT-IN, default OFF): when lib/jev-client.js reports enabled
//   (~/.anti-hall/jev.json {"enabled":true} or ANTIHALL_JEV=1; ANTIHALL_JEV=0
//   always wins), TypeSafe's Jev classifier is asked FIRST with JEV_QUESTION.
//   ASYMMETRIC TRUST: only a confident "speculative" answer (confidence >=
//   confidenceThreshold) short-circuits to a BLOCK. A confident "grounded"
//   answer, a low-confidence answer, or any Jev failure (no key, timeout, HTTP
//   error, bad response) falls through to the regex logic below, unchanged —
//   Jev can add blocks the regex misses, never remove one. Both paths share the
//   same loop-safety (one block per message hash, MAX_BLOCKS per session).
//   While Jev is enabled every decision appends one line to
//   ~/.anti-hall/logs/jev-judge.ndjson (no message text, no key). With Jev
//   disabled (the default) behavior is identical to the regex-only hook and
//   nothing is logged.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { transcript_path, session_id?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing
//   exit 0 : always

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --------------------------------------------------------------------------
// Speculation markers — case-insensitive, must appear at a word boundary.
// These are hedge words that assert something as probably-true without evidence.
// --------------------------------------------------------------------------
const SPECULATION_PATTERNS = [
  /\bvery plausibly\b/i,
  /\bplausibly\b/i,
  /\bpresumably\b/i,
  /\bi suspect\b/i,
  /\bmy guess\b/i,
  /\bi'?d guess\b/i,
  /\bi bet\b/i,
  /\blikely\b/i,
  /\bprobably\b/i,
  /\bmust be\b/i,
  // "should be" (a guess about state). "should I" is a question and already does
  // not match this phrase. The prior negative-lookahead `(?!\s+\w)` wrongly
  // skipped "should be fine"/"should be X" — exactly the speculative cases we
  // want to catch — so it is removed.
  /\bshould be\b/i,
  /\bseems to be\b/i,
  /\bappears to be\b/i,
  /\bi think it'?s\b/i,
  /\bmy hunch\b/i,
];

// --------------------------------------------------------------------------
// Acknowledgment patterns — if any of these appear in the same message,
// the hedging is honest (the model is being transparent about uncertainty).
// Suppress the block when present.
// --------------------------------------------------------------------------
const ACKNOWLEDGMENT_PATTERNS = [
  /\bverified\b/i,
  /i don'?t know\b/i,
  /haven'?t checked\b/i,
  /\bnot verified\b/i,
  /\bunverified\b/i,
  /\blet me verify\b/i,
  /i'?ll check\b/i,
  /\bi will check\b/i,
  /\bneed to confirm\b/i,
  /\bto confirm\b/i,
  // file:line citation pattern  e.g. main.js:42 or foo_bar.py:123
  /\b\w+\.\w+:\d+\b/,
  /\brunning\b/i,
  /\bper the data\b/i,
  /\bthe data shows\b/i,
];

// --------------------------------------------------------------------------
// Jev question (Noul): true == speculative (block), false == grounded.
// Wording chosen from a labelled probe (docs/KB-jev-classifier.md §4): the
// previous Tier-3 rubric required "NO hedge word" for true, so hedged guesses
// ("probably ... should work now, I think the tests pass") were confidently
// answered false. Speculation here explicitly INCLUDES hedged guesses.
// --------------------------------------------------------------------------
const JEV_QUESTION = {
  type: 'noul',
  instructions:
    'Is this assistant message speculative, i.e. does it assert a cause or an ' +
    'outcome about the project without cited evidence?',
  criteria: {
    true:
      'Speculative: it asserts a cause, a fix, or a done/works/passes/resolved ' +
      'outcome about the project with no cited command output, test result, or ' +
      'file:line reference. Hedged guesses ("probably", "should work", "I think", ' +
      '"it seems") and confident but unsupported statements ("Fixed.", "All done") ' +
      'are both speculative.',
    false:
      'Not speculative: it reports what a tool actually showed (command output such ' +
      'as "12 pass, 0 fail", a commit hash, grep results, a file:line reference like ' +
      'src/app.js:42); or it honestly says something is not yet verified and names ' +
      'the check to run; or it makes no claim about the project at all (a question, ' +
      'a plan, code the user asked for, general technical knowledge, an explicit ' +
      'hypothetical, or small talk).',
  },
};

// appendJevLog(entry) — bounded, best-effort append to
// ~/.anti-hall/logs/jev-judge.ndjson (truncated once it exceeds ~1MB). Never
// throws; a logging failure must never affect the decision.
const JEV_LOG_MAX_BYTES = 1024 * 1024;
function appendJevLog(entry) {
  try {
    const logDir = path.join(os.homedir(), '.anti-hall', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'jev-judge.ndjson');
    try {
      if (fs.statSync(logPath).size > JEV_LOG_MAX_BYTES) fs.writeFileSync(logPath, '', 'utf8');
    } catch (_) {
      // file doesn't exist yet
    }
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // best-effort only
  }
}

// --------------------------------------------------------------------------
// Bounded tail read: load only the last `windowBytes` of a (possibly multi-GB)
// transcript instead of the whole file, so a huge transcript can never OOM or
// stall this hook. The last assistant message lives at the end of the JSONL, so
// the trailing window is sufficient. If the file is smaller than the window we
// read it all. The first line of a mid-file window is almost certainly a partial
// (truncated) JSON line; we drop it so the JSONL parser never trips on it (it
// would be skipped anyway, but dropping it is explicit and avoids ambiguity).
// Any error -> null (caller fails open).
// --------------------------------------------------------------------------
function readTranscriptTail(transcriptPath, windowBytes) {
  const WINDOW = windowBytes || 512 * 1024; // 512 KB default
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= WINDOW) {
      return { data: fs.readFileSync(transcriptPath, 'utf8'), truncated: false };
    }
    const start = size - WINDOW;
    const buf = Buffer.alloc(WINDOW);
    fd = fs.openSync(transcriptPath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, WINDOW, start);
    return { data: buf.toString('utf8', 0, bytesRead), truncated: true };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

// --------------------------------------------------------------------------
// Extract the last assistant message text from a transcript JSONL file.
// Returns null if nothing is found or any error occurs.
//
// Two extraction variants share the same scan/parse plumbing but differ in
// collectTextFromEntry:
//   - legacy (collectTextFromEntryLegacy): the pre-3e72bf3 behavior, restored
//     BYTE-IDENTICAL. It can duplicate text when `content` was read from
//     node.message (the real transcript shape) and the recursion into
//     node.message re-collects the same block. This is INTENTIONALLY kept for
//     the regex path and the loop-safety hash so both stay identical to the
//     pre-3e72bf3 hook — the duplication can shift where a regex matches (or
//     doesn't) at the boundary, and changing it would silently change verdicts
//     and the stored hash for already-deployed state files.
//   - deduplicated (collectTextFromEntryDedup): skips the duplicate re-collection.
//     Used ONLY as the Jev input (lastText.slice(0, 8000) below), since Jev is
//     a new code path with no pre-existing byte-identical contract to preserve.
// --------------------------------------------------------------------------
function extractLastAssistantTextWith(transcriptPath, collectFn) {
  const tail = readTranscriptTail(transcriptPath);
  if (!tail) {
    return null;
  }

  const lines = tail.data.split(/\r?\n/);
  // When the window starts mid-file, the first line is a possibly-truncated
  // partial JSON line; drop it so we never parse a fragment.
  if (tail.truncated && lines.length > 0) {
    lines.shift();
  }
  let lastText = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    // Look for assistant role messages
    const role = entry && (entry.role || (entry.message && entry.message.role));
    if (role !== 'assistant') continue;

    // Collect all text content blocks from this message
    const text = collectFn(entry);
    if (text) {
      lastText = text;
    }
  }

  return lastText;
}

function extractLastAssistantTextLegacy(transcriptPath) {
  return extractLastAssistantTextWith(transcriptPath, collectTextFromEntryLegacy);
}

function extractLastAssistantTextDedup(transcriptPath) {
  return extractLastAssistantTextWith(transcriptPath, collectTextFromEntryDedup);
}

// Recursively collect concatenated text from content blocks in an entry.
// LEGACY (pre-3e72bf3, restored as-is): always recurses into node.message
// when present, which can duplicate text already picked up via node.content.
function collectTextFromEntryLegacy(node) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];

  // Direct text field
  if (typeof node.text === 'string') {
    parts.push(node.text);
  }

  // content array (Claude message format)
  const content = node.content || (node.message && node.message.content);
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }

  // Recurse into message field if not already handled above
  if (node.message && typeof node.message === 'object' && node.message !== node) {
    const sub = collectTextFromEntryLegacy(node.message);
    if (sub) parts.push(sub);
  }

  return parts.join(' ');
}

// Deduplicated variant (Jev input only — see comment above).
function collectTextFromEntryDedup(node) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];

  // Direct text field
  if (typeof node.text === 'string') {
    parts.push(node.text);
  }

  // content array (Claude message format)
  const content = node.content || (node.message && node.message.content);
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }

  // Recurse into message field if not already handled above. When `content`
  // was taken from node.message (the real transcript shape), recursing would
  // append the same text a second time — skip it.
  if (node.message && typeof node.message === 'object' && node.message !== node && node.content) {
    const sub = collectTextFromEntryDedup(node.message);
    if (sub) parts.push(sub);
  }

  return parts.join(' ');
}

// --------------------------------------------------------------------------
// Find the first matching speculation marker label (for the block reason).
// --------------------------------------------------------------------------
function findSpeculationMarker(text) {
  for (const pat of SPECULATION_PATTERNS) {
    const m = text.match(pat);
    if (m) return m[0];
  }
  return null;
}

function hasAcknowledgment(text) {
  for (const pat of ACKNOWLEDGMENT_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  const { isSkipped } = require('./skip-guard.js');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    process.exit(0);
  }

  // Derive a stable session key (same approach as task-guard.js).
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');

  // State file under ~/.anti-hall/ (not os.tmpdir) so it survives across
  // processes in the same session even when tmpdir varies.
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'speculation-guard-state-' + safeSession + '.json');

  // Extract the last assistant message text. The LEGACY (pre-3e72bf3, possibly
  // duplicated) text drives the regex path and the loop-safety hash so both
  // stay byte-identical to the pre-Jev hook. The deduplicated text is computed
  // lazily below and used ONLY as Jev's input.
  const lastText = extractLastAssistantTextLegacy(transcriptPath);
  if (!lastText) {
    process.exit(0);
  }

  // Compute a hash of the last message text for loop-safety.
  const msgHash = crypto.createHash('sha1').update(lastText).digest('hex');

  // Load prior state: { hash, blocks, pending }. Tolerate a legacy bare-hash string.
  // `pending` ({h, source}), when present, is the outcome-capture record left
  // by the PREVIOUS Stop's block (see below) — set only when this hook itself
  // blocked, never by an external writer.
  let lastBlockedHash = '';
  let blocks = 0;
  let pending = null;
  try {
    const stateRaw = fs.readFileSync(stateFile, 'utf8').trim();
    if (stateRaw) {
      const parsed = JSON.parse(stateRaw);
      if (parsed && typeof parsed === 'object') {
        lastBlockedHash = typeof parsed.hash === 'string' ? parsed.hash : '';
        blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
        pending = (parsed.pending && typeof parsed.pending === 'object' &&
          typeof parsed.pending.h === 'string' && typeof parsed.pending.source === 'string')
          ? parsed.pending : null;
      } else {
        lastBlockedHash = stateRaw; // legacy bare-hash file
      }
    }
  } catch (_) {
    // No prior state — first time.
  }

  // ---------------------------------------------------------------------
  // OUTCOME CAPTURE: if the PREVIOUS Stop in this session produced a block
  // (Jev-added or regex), classify THIS reply against it and record the
  // outcome via jev-assist's shared metrics log — so `jev report` can compare
  // Jev-sourced vs regex-sourced block outcomes. Runs BEFORE the skip-hatch
  // short-circuit below (a skip itself is one of the three outcomes) and
  // independently of whatever this turn's own verdict ends up being.
  // Evidence detection reuses the SAME acknowledgment/marker regexes the
  // block decision itself uses — this does not attempt to detect "a tool
  // call happened in between" from the transcript; the acknowledgment
  // patterns (file:line refs, "running", "per the data", etc.) already cover
  // the common real case of a tool having run since the block.
  // ---------------------------------------------------------------------
  if (pending) {
    try {
      let outcome = null;
      if (isSkipped('speculation-guard')) {
        outcome = 'user-override';
      } else if (hasAcknowledgment(lastText)) {
        outcome = 'evidence-added';
      } else if (findSpeculationMarker(lastText)) {
        outcome = 'repeat-speculation';
      }
      if (outcome) {
        const { recordOutcome } = require('./lib/jev-assist.js');
        recordOutcome({ id: 'speculation', h: pending.h, outcome, source: pending.source });
      }
    } catch (_) {
      // Outcome capture is best-effort only — must never affect the decision.
    }
    // Clear the pending record now so it is evaluated exactly once. A fresh
    // block later in THIS turn (see the write near the bottom) overwrites
    // this with its own {hash, blocks, pending}.
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ hash: lastBlockedHash, blocks, pending: null }), 'utf8');
    } catch (_) {
      // Can't persist the clear -> harmless; worst case this pending record
      // is re-evaluated once more on the next Stop.
    }
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  if (isSkipped('speculation-guard')) process.exit(0);

  // Loop-safe: if we already blocked on this exact message, allow (nudged once).
  // Loop-safety 2: hard cap on total blocks this session. The message text
  // legitimately changes as the model reworks its reply, which defeats the
  // byte-identical hash dedupe; without a cap we could re-block on every Stop.
  // After MAX_BLOCKS nudges we stay quiet regardless of churn.
  const MAX_BLOCKS = 3;
  const loopSafe = msgHash === lastBlockedHash || blocks >= MAX_BLOCKS;

  // Regex verdict, computed up front (independent of Jev) purely so it can be
  // logged alongside Jev's own decision below — it does NOT change the
  // asymmetric-trust contract: Jev only ever ADDS a block via jev-assist's
  // 'add-block' trust (baseline false), the regex/acknowledgment check below
  // still runs on its own and is what actually blocks when Jev doesn't.
  const regexMarkerPreview = findSpeculationMarker(lastText);
  const regexWouldBlock = !!regexMarkerPreview &&
    !(regexMarkerPreview && hasAcknowledgment(lastText));

  // Jev first (opt-in, via lib/jev-assist.js's shared trust/mode layer).
  // logEntry stays null when Jev is disabled, so nothing is logged and the
  // regex path below behaves exactly as without Jev.
  let logEntry = null;
  let jevBlock = false;
  let jevResultHash = null;
  try {
    const { loadJevConfig } = require('./lib/jev-client.js');
    const jevCfg = loadJevConfig();
    if (jevCfg.enabled && loopSafe) {
      // Outcome is already "allow" — don't spend a Jev call on it.
      logEntry = { backend: 'none', reason: 'loop-safe', ms: null, confidence: null, regexVerdict: regexWouldBlock };
    } else if (jevCfg.enabled) {
      const { ask } = require('./lib/jev-assist.js');
      // Dedup text only for Jev's input — see extractLastAssistantTextWith comment.
      const jevText = extractLastAssistantTextDedup(transcriptPath) || lastText;
      const result = await ask({
        id: 'speculation',
        question: JEV_QUESTION,
        state: jevText.slice(0, 8000),
        trust: 'add-block',
        baseline: false,
      });
      if (result.jev === null) {
        // Either the 'speculation' integration is switched off via jev.json's
        // integrations map (Jev overall enabled, this one specifically not),
        // or the ask() call itself never ran — nothing new to log unless a
        // real jevDecide failure produced a reason.
        if (result.reason) {
          logEntry = {
            backend: 'jev→regex', reason: result.reason,
            ms: result.ms != null ? result.ms : null, confidence: null,
            regexVerdict: regexWouldBlock,
          };
        }
      } else if (result.final === true) {
        jevBlock = true;
        jevResultHash = result.h;
        logEntry = { backend: 'jev', reason: 'confident', ms: result.ms, confidence: result.confidence, regexVerdict: regexWouldBlock };
      } else {
        logEntry = {
          backend: 'jev→regex',
          reason: result.confident ? 'confident-allow-untrusted' : 'low-confidence',
          ms: result.ms != null ? result.ms : null,
          confidence: result.confidence,
          regexVerdict: regexWouldBlock,
        };
      }
    }
  } catch (_) {
    // Jev path unavailable for any reason — regex decides.
  }

  const finish = (verdict) => {
    if (logEntry) appendJevLog({ ts: new Date().toISOString(), ...logEntry, verdict });
    process.exit(0);
  };

  let marker = null;
  if (!jevBlock) {
    // Check for speculation markers.
    marker = findSpeculationMarker(lastText);
    if (!marker) finish('allow');

    // Check for acknowledgment — if present, hedging is honest; allow.
    if (hasAcknowledgment(lastText)) finish('allow');
  }

  if (loopSafe) finish('allow');

  // Persist the blocked hash + incremented count + a pending outcome-capture
  // record (source + a hash to join back to later) before outputting the
  // decision. Regex-sourced blocks never call ask(), so they have no
  // jev-assist decision hash to join to — msgHash still uniquely identifies
  // the outcome row for `jev report`'s per-source comparison.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const pendingRecord = jevBlock
      ? { h: jevResultHash || msgHash, source: 'jev' }
      : { h: msgHash, source: 'regex' };
    fs.writeFileSync(stateFile, JSON.stringify({ hash: msgHash, blocks: blocks + 1, pending: pendingRecord }), 'utf8');
  } catch (_) {
    // Can't persist -> fail-open to avoid loops.
    finish('allow');
  }
  // Opportunistic bounded self-prune of OTHER stale speculation-guard-state-*
  // files (one per session, never cleaned otherwise — see lib/state-prune.js).
  try {
    require('./lib/state-prune.js').pruneStale({
      stateDir, prefix: 'speculation-guard-state', keepFile: stateFile,
    });
  } catch (_) {}

  const reason = jevBlock
    ? 'anti-hall speculation-guard: your reply asserts a cause or outcome without ' +
      'citing evidence (command output, a test result, or a file:line reference). ' +
      'Verify it with a tool, or explicitly say what\'s unverified / \'I don\'t know - ' +
      'here\'s what I\'d check\', then continue.'
    : 'anti-hall speculation-guard: your reply states something speculative (\'' +
      marker +
      '\') without verifying it or flagging it as unverified. ' +
      'Verify it with a tool, or explicitly say what\'s unverified / \'I don\'t know - ' +
      'here\'s what I\'d check\', then continue.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  finish('block');
}

main().catch(() => {
  // Fail-open: never wedge a Stop.
  process.exit(0);
});
