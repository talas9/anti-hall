#!/usr/bin/env node
'use strict';
// merge-gate.js — OPT-IN PreToolUse gate (Bash) backstopping the v0.30.0 "false
// done" discipline. DEFAULT OFF.
//
// WHAT IT DOES (only when ANTIHALL_MERGE_GATE is on):
//   Mechanizes the ONE checkable part of the "false done" failure — the agent
//   wrote a self-hedge ("first-pass" / "pending review" / "do not merge") in its
//   own recent output, then turned around and AUTO-MERGED anyway. If a Bash
//   command is an AUTO-MERGE intent (`gh pr merge`, `gh pr merge --auto`, `gh pr
//   review --approve`, `git merge --no-ff/--ff into main|master|develop`) AND the
//   recent assistant transcript tail still carries an UNRESOLVED self-hedge, it
//   BLOCKS (exit 2) and tells the agent to verify-or-get-sign-off first.
//
// HONEST LIMITS (read before trusting this):
//   1. KEYWORD HEURISTIC — it matches a fixed phrase list ("pending review",
//      "first-pass", "do not merge", …). It cannot understand the output; a hedge
//      worded differently slips through, and an innocent quote of one of those
//      phrases could false-block (mitigated by the resolution-token allowance).
//   2. BYPASSABLE — it only inspects the parsed Bash command. An alternate merge
//      syntax, a heredoc, an API call, or merging from the GitHub UI is not seen.
//      It is a speed-bump on the honest path, not a sandbox.
//   3. DEFAULT-OFF — env unset ⇒ pure no-op (exit 0). You must opt in.
//   4. FAIL-OPEN — any error (no transcript, parse failure, fs error, bad stdin)
//      ⇒ exit 0 (allow). A buggy gate must never block the user.
//   5. CANNOT HARD-LOOP — PreToolUse is single-shot per tool call and holds NO
//      state; it decides allow/block from the current command + transcript tail
//      only. There is no counter to wedge and no re-fire loop.
// It is a BACKSTOP on the evidenced v0.30.0 "verify before you call it done"
// discipline — NOT a guarantee.

const fs = require('fs');

// Bounded transcript tail-scan budget (mirror task-tracker's capped readTail).
// Small enough to stay well under the 10s hook timeout; the recent hedge we care
// about lives in the last assistant turn(s), not megabytes back.
const SCAN_WINDOW = 128 * 1024;

// ON only when the env var is an explicit affirmative. Anything else = off.
function gateEnabled() {
  const v = process.env.ANTIHALL_MERGE_GATE;
  return typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim());
}

// Self-hedge phrases (case-insensitive). Each entry may be a string or a RegExp
// (for the punctuation/spacing variants like "first-pass"/"first pass"). The
// matched HUMAN-READABLE phrase is surfaced in the block reason.
const HEDGES = [
  'pending owner',
  'do not merge',
  /first[- ]pass/i,
  /not pixel[- ]perfect/i,
  'pending review',
  'needs your review',
  'needs your eyes',
  'review it in the build',
  'built, pending',
];

// Resolution tokens — if one of these appears in the tail, the hedge is treated
// as RESOLVED (the agent verified it / got sign-off) and the merge is allowed.
const RESOLUTIONS = [
  'owner approved',
  'owner signed off',
  'fidelity verified',
  'verified against',
  'resolved:',
  'sign-off received',
];

function lc(s) { return String(s || '').toLowerCase(); }

// firstHedge(text): return the human-readable phrase of the FIRST hedge found in
// `text`, or null. RegExp entries report their source pattern in a readable form.
function firstHedge(text) {
  const t = lc(text);
  for (const h of HEDGES) {
    if (h instanceof RegExp) {
      const m = h.exec(text);
      if (m) return m[0];
    } else if (t.indexOf(h) !== -1) {
      return h;
    }
  }
  return null;
}

// lastHedgePhrase(text): return the human-readable phrase of the LAST (rightmost)
// hedge found in text, or null. Used to report which hedge actually blocked.
function lastHedgePhrase(text) {
  const t = lc(text);
  let lastPhrase = null;
  let maxIdx = -1;
  for (const h of HEDGES) {
    let idx = -1;
    let phrase = null;
    if (h instanceof RegExp) {
      const pattern = h.source;
      // Preserve the flags (especially 'i' for case-insensitive), ensure 'g' is present
      let flags = h.flags || '';
      if (!flags.includes('g')) flags += 'g';
      const re = new RegExp(pattern, flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        idx = m.index;
        phrase = m[0];
      }
    } else {
      idx = t.lastIndexOf(h);
      phrase = h;
    }
    if (idx > maxIdx) {
      maxIdx = idx;
      lastPhrase = phrase;
    }
  }
  return lastPhrase;
}

// lastHedgeIndex(text): return the index of the LAST (rightmost) hedge phrase
// occurrence in text, or -1 if no hedge found. Order-sensitive for resolution check.
function lastHedgeIndex(text) {
  const t = lc(text);
  let maxIdx = -1;
  for (const h of HEDGES) {
    let idx = -1;
    if (h instanceof RegExp) {
      // For RegExp: find all matches and use the last one's starting position.
      // Preserve flags (especially 'i'), ensure 'g' is present.
      const pattern = h.source;
      let flags = h.flags || '';
      if (!flags.includes('g')) flags += 'g';
      const re = new RegExp(pattern, flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        idx = m.index;
      }
    } else {
      idx = t.lastIndexOf(h);
    }
    if (idx > maxIdx) maxIdx = idx;
  }
  return maxIdx;
}

// lastResolutionIndex(text): return the index of the LAST (rightmost) resolution
// token occurrence in text, or -1 if none found. Order-sensitive: hedge must be
// AFTER (have a higher index than) this to block.
function lastResolutionIndex(text) {
  const t = lc(text);
  let maxIdx = -1;
  for (const r of RESOLUTIONS) {
    const idx = t.lastIndexOf(r);
    if (idx > maxIdx) maxIdx = idx;
  }
  return maxIdx;
}

// isHedgeUnresolved(text): true if there is an unresolved hedge = the LAST hedge
// index is greater than the LAST resolution index (a hedge appeared after the most
// recent resolution token).
function isHedgeUnresolved(text) {
  const lastHedge = lastHedgeIndex(text);
  if (lastHedge === -1) return false; // no hedge
  const lastRes = lastResolutionIndex(text);
  return lastHedge > lastRes; // hedge is unresolved if it comes AFTER resolution
}

// Bounded tail read (mirror task-tracker readTail): read only the last
// windowBytes of the transcript so the scan is cheap and bounded.
function readTail(transcriptPath, windowBytes) {
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= windowBytes) {
      return { data: fs.readFileSync(transcriptPath, 'utf8'), truncated: false };
    }
    const buf = Buffer.alloc(windowBytes);
    fd = fs.openSync(transcriptPath, 'r');
    const n = fs.readSync(fd, buf, 0, windowBytes, size - windowBytes);
    return { data: buf.toString('utf8', 0, n), truncated: true };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// recentAssistantText(transcriptPath): concatenate the TEXT of recent assistant
// turns in the tail window. JSONL transcript; each line is one event. We only
// look at assistant text blocks (the agent's OWN output — a hedge in a user
// message or tool result is not the agent hedging). Fail-open to '' on error.
function recentAssistantText(transcriptPath) {
  const tail = readTail(transcriptPath, SCAN_WINDOW);
  if (!tail || !tail.data) return '';
  const lines = tail.data.split(/\r?\n/);
  // Drop the first (likely partial) line ONLY when we truncated the head; a
  // whole, untruncated transcript's first line is a complete event we must keep.
  if (tail.truncated && lines.length > 0) lines.shift();
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try { entry = JSON.parse(t); } catch (_) { continue; }
    if (!entry || entry.type !== 'assistant') continue;
    const content = entry.message && entry.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          out.push(block.text);
        }
      }
    } else if (typeof content === 'string') {
      out.push(content);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Minimal Bash auto-merge detection. We do NOT need git-guard's full tokenizer
// here: a conservative word-level scan is enough for this backstop, and any parse
// uncertainty fails OPEN (no block). We look at each operator-split segment.
function splitSegments(cmd) {
  // Split on the common shell separators OUTSIDE quotes. Coarse but sufficient:
  // worst case we under-split and scan a slightly larger string, which can only
  // make detection MORE permissive at segment boundaries (fail-open friendly).
  return cmd.split(/&&|\|\||[;&|\n]/);
}

// isAutoMerge(cmd): true if any segment is an auto-merge intent.
//   - gh pr merge ...            (any `gh pr merge`, incl. --auto)
//   - gh pr review --approve ... (approve that can enable merge)
//   - git merge --no-ff|--ff ... <main|master|develop>
function isAutoMerge(cmd) {
  for (const seg of splitSegments(cmd)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    // Locate the command verb, skipping a leading env-assignment / simple wrapper.
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const verb = words[i];
    const rest = words.slice(i + 1);
    if (verb === 'gh') {
      // gh pr merge ... / gh pr review --approve ...
      if (rest[0] === 'pr' && rest[1] === 'merge') return true;
      if (rest[0] === 'pr' && rest[1] === 'review' && rest.includes('--approve')) return true;
    } else if (verb === 'git') {
      if (rest[0] === 'merge') {
        const flags = rest.slice(1);
        const hasFastFlag = flags.includes('--no-ff') || flags.includes('--ff') || flags.includes('--ff-only');
        const targetsProtected = flags.some((w) => /^(main|master|develop|origin\/(main|master|develop))$/i.test(w));
        if (hasFastFlag && targetsProtected) return true;
      }
    }
  }
  return false;
}

function main() {
  // 1. Read stdin first; on any read failure fail-open.
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }

  // 2. Skip-hatch: an explicit user opt-out disables this guard (TTL'd).
  let isSkipped;
  try { ({ isSkipped } = require('./skip-guard.js')); } catch (_) { isSkipped = () => false; }
  try { if (isSkipped('merge-gate')) process.exit(0); } catch (_) { /* fail-open */ }

  // 3. DEFAULT OFF — no-op unless explicitly enabled.
  if (!gateEnabled()) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); }

  const ti = payload && payload.tool_input;
  const cmd = ti && typeof ti.command === 'string' ? ti.command : '';
  if (!cmd) process.exit(0);

  // 4. Only consider AUTO-MERGE commands.
  if (!isAutoMerge(cmd)) process.exit(0);

  // 5. Scan the recent assistant output for an UNRESOLVED hedge.
  const tp = payload && payload.transcript_path;
  if (!tp || typeof tp !== 'string') process.exit(0); // no transcript -> fail-open allow
  const text = recentAssistantText(tp);
  if (!text) process.exit(0);

  const hedge = firstHedge(text);
  if (!hedge) process.exit(0);           // no hedge -> allow
  if (!isHedgeUnresolved(text)) process.exit(0); // hedge present but resolved (or resolution came after) -> allow

  // 6. Unresolved hedge + auto-merge -> BLOCK.
  // Report the LAST hedge that actually triggered the block (order-sensitive).
  const blockingHedge = lastHedgePhrase(text) || hedge;
  const reason =
    'merge-gate: your recent output flagged a deliverable as pending/unverified ("' +
    blockingHedge + '") — a self-issued hedge blocks auto-merge (false-done backstop). ' +
    'Verify it against its agreed criterion or get owner sign-off, then merge; or ' +
    'skip via ANTIHALL_MERGE_GATE off / isSkipped(\'merge-gate\').';

  process.stderr.write(reason + '\n');
  process.exit(2);
}

try { main(); } catch (_) { process.exit(0); } // fail-open on anything unexpected
