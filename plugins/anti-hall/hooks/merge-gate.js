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
//   review --approve`, `git merge --no-ff/--ff into main|master|develop`,
//   `hivecontrol workspace merge-into-source|merge-from-source`) AND the
//   recent assistant transcript tail still carries an UNRESOLVED self-hedge, it
//   BLOCKS (exit 2) and tells the agent to verify-or-get-sign-off first.
//
// HONEST LIMITS (read before trusting this):
//   1. KEYWORD HEURISTIC — it matches a fixed phrase list ("pending review",
//      "first-pass", "do not merge", …). It cannot understand the output; a hedge
//      worded differently slips through. Hedges inside quotes/code/blockquotes
//      are masked (not a self-hedge). RESOLUTION is structural: only a real
//      user prompt typed after the hedge can clear it — the assistant never can.
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

// ON only when explicitly enabled — env var (highest precedence) or
// ~/.anti-hall/settings.json guards.mergeGate (v0.108.0 unified settings; see
// hooks/lib/settings.js). Fail-open to disabled on any error.
function gateEnabled() {
  try {
    return require('./lib/settings.js').get('guards', 'mergeGate') === true;
  } catch (_) {
    return false;
  }
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

// Resolution tokens. ONLY THE USER can sign off: a hedge is RESOLVED solely by a
// REAL user prompt typed AFTER the hedge that contains one of these phrases (a
// user-role record with no peer/non-human origin, not meta/sidechain/hook-
// injected, not a tool_result, not a task-notification / system-reminder /
// cross-session-message body). The assistant can never clear its own hedge —
// not by quoting a phrase, and not by writing one after a tool_result (a blocked
// merge attempt is itself a tool_result). There is no ack/override file in this
// hook; the documented skip-hatch is isSkipped('merge-gate').
const USER_RESOLUTIONS = [
  'owner approved',
  'owner signed off',
  'sign-off received',
  'fidelity verified',
  'verified against',
  'resolved:',
];

function lc(s) { return String(s || '').toLowerCase(); }

// Quoted-text mask: hedge/resolution phrases inside quotes, inline code, code
// fences or blockquotes are not the session's own words. lib/quote-mask.js is a
// verbatim copy of speculation-guard.js's maskQuotedText; a test asserts the two
// give identical output so they cannot diverge.
const { maskQuotedText } = require('./lib/quote-mask.js');

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

function hasAny(text, phrases) {
  const t = lc(text);
  return phrases.some((p) => t.indexOf(p) !== -1);
}

// isHedgeUnresolved(records): `records` is the chronological list from
// readRecords(). The hedge is the LAST assistant record carrying a hedge; it is
// resolved only by a later real user prompt with a USER_RESOLUTIONS phrase.
function isHedgeUnresolved(records) {
  let hedgeAt = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].kind === 'assistant' && lastHedgeIndex(records[i].text) !== -1) hedgeAt = i;
  }
  if (hedgeAt === -1) return false;
  for (let j = hedgeAt + 1; j < records.length; j++) {
    if (records[j].kind === 'user' && hasAny(records[j].text, USER_RESOLUTIONS)) return false;
  }
  return true;
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

// Injected user-role bodies that are not a human typing.
const INJECTED_USER_RE = /^\s*(<(task-notification|system-reminder|command-name|command-message|local-command|user-prompt-submit-hook|cross-session-message)\b|Stop hook feedback:)|Another Claude session sent a message|<cross-session-message\b/i;

// maskedMaybe(text): quote-masked text, falling back to the raw text if masking
// blanked every visible character.
function maskedMaybe(text) {
  const m = maskQuotedText(text);
  return m.trim() === '' && text.trim() !== '' ? text : m;
}

// readRecords(transcriptPath): chronological [{kind, text}] from the tail
// window. kind: 'assistant' (own text blocks, quote-masked), 'user' (a REAL typed
// prompt: user-role, not meta/sidechain/compact-summary, no tool_result, not an
// injected task-notification/system-reminder body; quote-masked), 'toolresult'
// (a user-role record carrying a tool_result), 'other' (ignored). Fail-open to [].
function readRecords(transcriptPath) {
  const tail = readTail(transcriptPath, SCAN_WINDOW);
  if (!tail || !tail.data) return [];
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
    if (!entry) continue;
    const content = entry.message && entry.message.content;
    const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    const textOf = () => blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    if (entry.type === 'assistant') {
      out.push({ kind: 'assistant', text: maskedMaybe(textOf()) });
    } else if (entry.type === 'user') {
      // A typed prompt has no `origin` (null/absent); a peer/system-originated
      // record carries origin.kind (e.g. "peer") even when isMeta is missing.
      const nonHuman = entry.origin && !['human', 'user'].includes(String(entry.origin.kind));
      if (entry.isMeta || entry.isSidechain || entry.isCompactSummary || nonHuman) { out.push({ kind: 'other', text: '' }); continue; }
      if (entry.toolUseResult !== undefined || blocks.some((b) => b && b.type === 'tool_result')) {
        out.push({ kind: 'toolresult', text: '' });
        continue;
      }
      const raw = textOf().replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
      if (!raw.trim() || INJECTED_USER_RE.test(raw)) { out.push({ kind: 'other', text: '' }); continue; }
      out.push({ kind: 'user', text: maskedMaybe(raw) });
    }
  }
  return out;
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
//   - hivecontrol workspace merge-into-source|merge-from-source (DevSwarm real
//     `git merge`; see docs/KB-devswarm-hivecontrol.md:139-140,240-245)
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
    } else if (verb === 'hivecontrol') {
      // hivecontrol workspace merge-into-source / merge-from-source — a real
      // `git merge` a DevSwarm child/parent workspace can run without a `gh`/`git`
      // verb, so it needs its own auto-merge branch here.
      if (rest[0] === 'workspace' && (rest[1] === 'merge-into-source' || rest[1] === 'merge-from-source')) return true;
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
  const records = readRecords(tp);
  const text = records.filter((r) => r.kind === 'assistant').map((r) => r.text).join('\n');
  if (!text) process.exit(0);

  const hedge = firstHedge(text);
  if (!hedge) process.exit(0);           // no hedge -> allow
  const unresolved = isHedgeUnresolved(records);

  // JEV SHADOW (mergeGateHedge, default mode "shadow"): only on merge
  // commands (already this gate's scope, reached above). baseline = the
  // regex's own isHedgeUnresolved() verdict; trust 'relax-block' means an
  // "on" promotion could let a confident Jev disagreement relax the block —
  // but this hook is on the USER'S CRITICAL PATH (it gates a live Bash tool
  // call), so shadow's ask must add ZERO latency: dispatched via
  // askDetached (fire-and-forget), never askSync. NOTE: because of that,
  // even a future "on" promotion of THIS id would not actually relax the
  // exit code below (the caller never sees the answer) — an "on" mode for
  // mergeGateHedge would need to switch back to askSync deliberately,
  // trading latency for enforcement. Shadow logs to jev-assist.ndjson only.
  try {
    const jevAssist = require('./lib/jev-assist.js');
    jevAssist.askDetached({
      id: 'mergeGateHedge',
      question: {
        type: 'noul',
        instructions: 'Does the recent reply text below contain an UNRESOLVED ' +
          'self-hedge (e.g. "pending review", "first-pass", "do not merge") that ' +
          'was never followed by a resolution/sign-off?',
        criteria: { true: 'unresolved hedge present', false: 'no unresolved hedge' },
      },
      state: text.slice(-4000),
      trust: 'relax-block',
      baseline: unresolved,
      sessionId: payload && payload.session_id ? String(payload.session_id) : undefined,
      turnRef: jevAssist.turnRefFromTranscript(tp),
    });
  } catch (_) { /* best-effort — never affects the gate's own decision */ }

  if (!unresolved) process.exit(0); // hedge present but resolved (or resolution came after) -> allow

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
