#!/usr/bin/env node
// anti-hall :: claim-ledger (Stop hook, LEDGER-ONLY — never blocks)
//
// PURPOSE
//   The lexical speculation-guard catches hedge words. The opt-in
//   speculation-judge (sibling, untouched) needs an API key and a model call.
//   This hook is the DETERMINISTIC tier in between: it cross-checks the last
//   assistant message against the evidence the session actually produced
//   (tool results, tool inputs, hook attachments, user prompts) and records
//   every "checkable" token whose referent never appeared in that evidence —
//   a count with a unit noun, a git SHA, "task N of", "N days ago", or a
//   runtime-state claim ("still running") made in a turn with zero tool calls.
//
//   It is ledger-only for one release: it writes what it WOULD have flagged so
//   the real false-positive rate can be measured before any blocking is turned
//   on. It never emits {decision:"block"}, never exits non-zero, never prints.
//
// EVIDENCE MODEL (this is the tuning that matters — do not "simplify" it)
//   - Evidence is CUMULATIVE across the session window, not per turn. A number
//     measured three turns ago is a legitimate referent now. Per-turn evidence
//     flagged 20% of real messages; cumulative flagged 1.7%.
//   - The window is the last EVIDENCE_WINDOW bytes of the transcript (2 MB),
//     so a 250 MB transcript cannot degrade the hook.
//   - Numbers are matched by VALUE at the claim's precision, not by substring:
//     an assistant that writes "34.9 s" after a tool printed "34.887 total" is
//     rounding, not inventing. Thousands separators are stripped on both sides.
//   - Runtime-state words are only recorded when the turn ran NO tool at all —
//     "the agent is still running" right after a tool call is at least
//     grounded in something; with zero tool calls it is memory or invention.
//
// CLASSES (recorded, no behavioral effect yet)
//   hard : count / sha / task-N-of absent from evidence — the class that would
//          block once blocking is enabled.
//   soft : state-word with no tool call this turn; "N days ago" (date
//          arithmetic the checker cannot verify) — the class that would only
//          nudge.
//
// LEDGER
//   ~/.anti-hall/claim-ledger/<session>.jsonl — append-only, one JSON record
//   per flagged turn: { ts, session, hash, tools_this_turn, flags:[{cls, kind,
//   token, context}] , msg_chars, evidence_chars, window_truncated }.
//   A turn is recorded at most once (hash of the message text, kept in the
//   same directory as <session>.last) so a Stop that fires twice for the same
//   message does not double-count.
//
// FAIL-OPEN
//   Any error anywhere (stdin, JSON, transcript, ledger write) => exit 0
//   silently. The hook has no upside that justifies wedging a session.
//
// Contract (Claude Code / Codex Stop hook):
//   stdin  : JSON { transcript_path, session_id?, ... }
//   stdout : nothing, ever
//   exit 0 : always

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EVIDENCE_WINDOW = 2 * 1024 * 1024;
const CONTEXT_CHARS = 160;
const MAX_FLAGS_PER_TURN = 40;

// --- transcript reading (tail window, same idiom as speculation-judge.js) ---

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

function asText(v) {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try { return JSON.stringify(v); } catch (_) { return ''; }
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out.join(' ');
}

// walk(lines) -> { lastText, evidence, toolsThisTurn } or null.
// Evidence is everything in the window EXCEPT the final assistant text itself.
// Turn boundary = a user entry that carries no tool_result block.
function walk(lines) {
  const ev = [];
  let toolsThisTurn = 0;
  let last = null; // { text, evLen, tools }
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch (_) { continue; }
    if (!e || typeof e !== 'object') continue;
    const role = e.type || (e.message && e.message.role);
    const content = e.message ? e.message.content : e.content;

    if (role === 'user') {
      const blocks = Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b && b.type === 'tool_result');
      if (results.length) {
        for (const r of results) ev.push(asText(r.content));
        if (e.toolUseResult !== undefined) ev.push(asText(e.toolUseResult));
      } else {
        toolsThisTurn = 0;
        ev.push(asText(content));
      }
      continue;
    }
    if (role === 'attachment') {
      ev.push(asText(e.attachment));
      continue;
    }
    if (role === 'assistant') {
      const blocks = Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b && b.type === 'tool_use') { toolsThisTurn++; ev.push(asText(b.input)); }
      }
      const text = textBlocks(content);
      if (text.trim()) {
        // Previous assistant text becomes evidence only once a NEWER one exists
        // (the message under test must not vouch for itself).
        if (last) ev.push(last.text);
        last = { text, tools: toolsThisTurn };
      }
    }
  }
  if (!last) return null;
  return { lastText: last.text, evidence: ev.join('\n'), toolsThisTurn: last.tools };
}

// --- numeric matching by value at the claim's precision ---

function decimalsOf(s) {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function collectNumbers(evidence) {
  const out = [];
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(evidence)) !== null) {
    const v = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function numberInEvidence(tokenNum, evidence, evNums) {
  // Value match only — a substring test is both too loose ("34" inside
  // "34.887") and too strict ("34.9" vs "34.887"); rounding at the claim's
  // own precision is the honest test.
  const clean = tokenNum.replace(/,/g, '');
  const target = Number(clean);
  if (!Number.isFinite(target)) return true; // unparseable => do not flag
  const tol = 0.5 * Math.pow(10, -decimalsOf(clean));
  for (let i = 0; i < evNums.length; i++) {
    if (Math.abs(evNums[i] - target) <= tol) return true;
  }
  return false;
}

// --- token extraction (carried over from the measured prototype) ---

// The number must not be glued to a preceding identifier char: "V2-4 workspace"
// is a name, not a count of 4 workspaces (a real false-positive mode).
const RE_COUNT = /(?<![\w.-])(\d{1,6}(?:[.,]\d+)?)\s*(ms|s|sec|seconds|minutes|min|hours|days?|weeks?|workspaces?|rows?|files?|lines?|tests?|bytes?|KB|MB|chars?|items?|entries|messages?|hooks?|agents?|commits?|matches|unread|live)\b/gi;
const RE_SHA = /\b[0-9a-f]{7,40}\b/g;
const RE_STATE = /\b(?:still|currently)\s+(?:running|live|active|pending|blocked)\b/gi;
const RE_TASK = /\btask\s+\d+\s+of\b/gi;
const RE_DAYS_AGO = /\b\d+\s+days?\s+ago\b/gi;

function contextAt(text, idx) {
  const start = text.lastIndexOf('\n', idx) + 1;
  let end = text.indexOf('\n', idx);
  if (end < 0) end = text.length;
  return text.slice(start, end).slice(0, CONTEXT_CHARS);
}

function extractFlags(text, evidence, toolsThisTurn) {
  const flags = [];
  const evNums = collectNumbers(evidence);
  const push = (cls, kind, token, idx) => {
    if (flags.length >= MAX_FLAGS_PER_TURN) return;
    flags.push({ cls, kind, token, context: contextAt(text, idx) });
  };
  let m;
  RE_COUNT.lastIndex = 0;
  while ((m = RE_COUNT.exec(text)) !== null) {
    if (!numberInEvidence(m[1], evidence, evNums)) push('hard', 'count', m[0], m.index);
  }
  RE_SHA.lastIndex = 0;
  while ((m = RE_SHA.exec(text)) !== null) {
    // Pure-digit runs are numbers, not SHAs; leave them to RE_COUNT.
    if (/^\d+$/.test(m[0])) continue;
    if (!evidence.includes(m[0])) push('hard', 'sha', m[0], m.index);
  }
  RE_TASK.lastIndex = 0;
  while ((m = RE_TASK.exec(text)) !== null) {
    if (!evidence.includes(m[0])) push('hard', 'task', m[0], m.index);
  }
  if (toolsThisTurn === 0) {
    RE_STATE.lastIndex = 0;
    while ((m = RE_STATE.exec(text)) !== null) push('soft', 'state-no-tool', m[0], m.index);
  }
  RE_DAYS_AGO.lastIndex = 0;
  while ((m = RE_DAYS_AGO.exec(text)) !== null) push('soft', 'days-ago', m[0], m.index);
  return flags;
}

// --- main ---

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return; }

  try {
    const { isSkipped } = require('./skip-guard.js');
    if (isSkipped('claim-ledger')) return;
  } catch (_) { /* skip-guard unavailable => proceed */ }

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }
  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') return;

  const tail = readTail(transcriptPath, EVIDENCE_WINDOW);
  if (!tail) return;
  const lines = tail.data.split(/\r?\n/);
  if (tail.truncated && lines.length) lines.shift(); // drop the partial first line

  const walked = walk(lines);
  if (!walked) return;

  const sessionId = (payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const ledgerDir = path.join(os.homedir(), '.anti-hall', 'claim-ledger');
  const lastFile = path.join(ledgerDir, safeSession + '.last');
  const hash = crypto.createHash('sha1').update(walked.lastText).digest('hex');

  // Record each distinct message once, even if Stop fires repeatedly for it.
  try {
    if (fs.readFileSync(lastFile, 'utf8').trim() === hash) return;
  } catch (_) { /* no prior record */ }

  const flags = extractFlags(walked.lastText, walked.evidence, walked.toolsThisTurn);

  try {
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(lastFile, hash, 'utf8');
    if (!flags.length) return;
    const rec = {
      ts: new Date().toISOString(),
      session: safeSession,
      hash,
      tools_this_turn: walked.toolsThisTurn,
      msg_chars: walked.lastText.length,
      evidence_chars: walked.evidence.length,
      window_truncated: tail.truncated,
      flags,
    };
    fs.appendFileSync(path.join(ledgerDir, safeSession + '.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  } catch (_) { /* fail-open */ }
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}

module.exports = { walk, extractFlags, numberInEvidence, collectNumbers, EVIDENCE_WINDOW };
