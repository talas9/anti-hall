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
// Extract the last assistant message text from a transcript JSONL file.
// Returns null if nothing is found or any error occurs.
// --------------------------------------------------------------------------
function extractLastAssistantText(transcriptPath) {
  let data;
  try {
    data = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    return null;
  }

  const lines = data.split(/\r?\n/);
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

  // Recurse into message field if not already handled above
  if (node.message && typeof node.message === 'object' && node.message !== node) {
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
function main() {
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

  // Check for speculation markers.
  const marker = findSpeculationMarker(lastText);
  if (!marker) {
    process.exit(0);
  }

  // Check for acknowledgment — if present, hedging is honest; allow.
  if (hasAcknowledgment(lastText)) {
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
  if (msgHash === lastBlockedHash) {
    process.exit(0);
  }

  // Loop-safety 2: hard cap on total blocks this session. The message text
  // legitimately changes as the model reworks its reply, which defeats the
  // byte-identical hash dedupe; without a cap we could re-block on every Stop.
  // After MAX_BLOCKS nudges we stay quiet regardless of churn.
  const MAX_BLOCKS = 3;
  if (blocks >= MAX_BLOCKS) {
    process.exit(0);
  }

  // Persist the blocked hash + incremented count before outputting the decision.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hash: msgHash, blocks: blocks + 1 }), 'utf8');
  } catch (_) {
    // Can't persist -> fail-open to avoid loops.
    process.exit(0);
  }

  const reason =
    'anti-hall speculation-guard: your reply states something speculative (\'' +
    marker +
    '\') without verifying it or flagging it as unverified. ' +
    'Verify it with a tool, or explicitly say what\'s unverified / \'I don\'t know - ' +
    'here\'s what I\'d check\', then continue.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

try {
  main();
} catch (_) {
  // Fail-open: never wedge a Stop.
  process.exit(0);
}
