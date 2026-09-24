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
// --------------------------------------------------------------------------
function extractLastAssistantText(transcriptPath) {
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
    const text = collectTextFromEntry(entry);
    if (text) {
      lastText = text;
    }
  }

  return lastText;
}

// Recursively collect concatenated text from content blocks in an entry.
function collectTextFromEntry(node) {
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
    const sub = collectTextFromEntry(node.message);
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

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('speculation-guard')) process.exit(0);

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

  // Extract the last assistant message text.
  const lastText = extractLastAssistantText(transcriptPath);
  if (!lastText) {
    process.exit(0);
  }

  // Compute a hash of the last message text for loop-safety.
  const msgHash = crypto.createHash('sha1').update(lastText).digest('hex');

  // Load prior state: { hash, blocks }. Tolerate a legacy bare-hash string.
  let lastBlockedHash = '';
  let blocks = 0;
  try {
    const stateRaw = fs.readFileSync(stateFile, 'utf8').trim();
    if (stateRaw) {
      const parsed = JSON.parse(stateRaw);
      if (parsed && typeof parsed === 'object') {
        lastBlockedHash = typeof parsed.hash === 'string' ? parsed.hash : '';
        blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
      } else {
        lastBlockedHash = stateRaw; // legacy bare-hash file
      }
    }
  } catch (_) {
    // No prior state — first time.
  }

  // Loop-safe: if we already blocked on this exact message, allow (nudged once).
  // Loop-safety 2: hard cap on total blocks this session. The message text
  // legitimately changes as the model reworks its reply, which defeats the
  // byte-identical hash dedupe; without a cap we could re-block on every Stop.
  // After MAX_BLOCKS nudges we stay quiet regardless of churn.
  const MAX_BLOCKS = 3;
  const loopSafe = msgHash === lastBlockedHash || blocks >= MAX_BLOCKS;

  // Jev first (opt-in). logEntry stays null when Jev is disabled, so nothing
  // is logged and the regex path below behaves exactly as without Jev.
  let logEntry = null;
  let jevBlock = false;
  try {
    const { jevDecide, loadJevConfig } = require('./lib/jev-client.js');
    const jevCfg = loadJevConfig();
    if (jevCfg.enabled && loopSafe) {
      // Outcome is already "allow" — don't spend a Jev call on it.
      logEntry = { backend: 'none', reason: 'loop-safe', ms: null, confidence: null };
    } else if (jevCfg.enabled) {
      const r = await jevDecide({ question: JEV_QUESTION, state: lastText.slice(0, 8000) });
      const confident = r.ok && r.confidence >= jevCfg.confidenceThreshold;
      if (confident && r.answer === true) {
        jevBlock = true;
        logEntry = { backend: 'jev', reason: 'confident', ms: r.ms, confidence: r.confidence };
      } else {
        logEntry = {
          backend: 'jev→regex',
          reason: !r.ok ? r.reason : (confident ? 'confident-allow-untrusted' : 'low-confidence'),
          ms: r.ms != null ? r.ms : null,
          confidence: r.ok ? r.confidence : null,
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

  // Persist the blocked hash + incremented count before outputting the decision.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hash: msgHash, blocks: blocks + 1 }), 'utf8');
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
