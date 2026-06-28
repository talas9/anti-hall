#!/usr/bin/env node
// anti-hall :: codex-nudge (Stop hook, loop-safe, ADVISORY)
//
// Fires on Stop. Scans the transcript tail for tool_use activity this session and
// nudges — ONCE — to get an independent OpenAI-Codex second opinion when the session
// shipped a SUBSTANTIAL code change but no Codex review happened. This mechanizes the
// everyday-routing policy (see skills/MODEL-POLICY.md "Everyday agent routing"):
// Codex is the cross-model correctness reviewer (off-by-one / races / subtle low-level
// bugs); Claude Opus owns planning/architecture/design review. The TRIO Critic seat in
// deadly-loop/ship-it already enforces this INSIDE those skills; this hook covers the
// MAIN agent's everyday edits, which otherwise never pull Codex unless asked.
//
// DECISION LOGIC:
//   substantial code edits (>= MIN) AND no Codex review this session -> NUDGE (block once)
//   a Codex review already present (subagent_type startsWith 'codex', or codex skill) -> ALLOW
//   fewer than MIN code edits -> ALLOW
//   any parse/read error -> ALLOW (fail-open)
//
// ADVISORY, NOT A GATE: the Stop event has no non-blocking advisory channel — only
// {decision:"block", reason} or silence. So the "nudge" is a SOFT block that fires at
// most MAX_NUDGES times per session (deduped on the signature of code files edited), so
// the model reads the reason, gets the Codex review (or acknowledges), then stops cleanly.
// It never wedges a Stop.
//
// CONFIG (env):
//   ANTIHALL_CODEX_NUDGE=off        -> disable entirely (fail-open exit 0)
//   ANTIHALL_CODEX_NUDGE_MIN=<n>    -> min code-file edits to count as "substantial" (default 3)
// Escape hatch: ~/.anti-hall/skip.json {"codex-nudge": <future-ts>} (shared skip-guard).
//
// FAIL-OPEN: any error -> exit 0, no block, no stderr noise.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { transcript_path, session_id?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to nudge, or nothing
//   exit 0 : always

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Code-file extensions that count toward a "substantial code change". Docs/config
// (.md/.json/.txt/.yml) deliberately excluded — a doc edit needs no Codex review.
const CODE_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|vue|svelte|dart|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|rb|php|cs|scala|sh|bash|sql)$/i;

const DEFAULT_MIN = 3;     // >= this many code-file edits => substantial
const MAX_NUDGES = 2;      // hard per-session cap (deduped on edited-files signature)

// Bounded tail read (mirror speculation-guard): load only the last windowBytes of a
// possibly-huge transcript so this hook can never OOM/stall. Any error -> null.
function readTranscriptTail(transcriptPath, windowBytes) {
  const WINDOW = windowBytes || 512 * 1024;
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
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Recursively collect tool_use nodes from a parsed JSONL entry (mirror task-tracker).
function collectTU(node) {
  if (!node || typeof node !== 'object') return [];
  const out = [];
  if (node.type === 'tool_use' && node.name) out.push(node);
  for (const k of ['content', 'message', 'messages', 'tool_uses', 'parts']) {
    const v = node[k];
    if (Array.isArray(v)) for (const it of v) out.push(...collectTU(it));
    else if (v && typeof v === 'object') out.push(...collectTU(v));
  }
  return out;
}

// Scan the transcript tail -> { codeFiles:Set<basename>, codeEdits:int, codexReview:bool }.
function scanTranscript(transcriptPath) {
  const tail = readTranscriptTail(transcriptPath);
  if (!tail) return null;
  const lines = tail.data.split(/\r?\n/);
  if (tail.truncated && lines.length > 0) lines.shift(); // drop partial first line
  const codeFiles = new Set();
  let codeEdits = 0;
  let codexReview = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try { entry = JSON.parse(t); } catch (_) { continue; }
    for (const tu of collectTU(entry)) {
      const name = tu.name || '';
      const inp = (tu.input && typeof tu.input === 'object') ? tu.input : {};
      // (a) substantial code edit?
      if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
        const fp = typeof inp.file_path === 'string' ? inp.file_path : '';
        if (fp && CODE_EXT.test(fp)) {
          codeEdits++;
          codeFiles.add(path.basename(fp));
        }
      }
      // (b) Codex review already happened? — Agent/Task spawn with a codex agent type,
      // or an invocation of the codex rescue skill. Check ALL agent-type field spellings:
      // the Agent tool uses `subagent_type`, the Workflow agent() API uses `agentType`
      // (ship-it/deadly-loop spawn the Critic seat that way) — missing it false-negatives
      // a real Codex review and over-nudges. `agent_type` covered for good measure.
      if (name === 'Agent' || name === 'Task') {
        const atype = (typeof inp.subagent_type === 'string' && inp.subagent_type) ||
                      (typeof inp.agentType === 'string' && inp.agentType) ||
                      (typeof inp.agent_type === 'string' && inp.agent_type) || '';
        if (/^codex\b|^codex:/i.test(atype)) codexReview = true;
      }
      if (name === 'Skill') {
        const s = (typeof inp.skill === 'string' ? inp.skill : '') + ' ' +
                  (typeof inp.command === 'string' ? inp.command : '');
        if (/codex/i.test(s)) codexReview = true;
      }
    }
  }
  return { codeFiles, codeEdits, codexReview };
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }

  // Env off-switch.
  if (String(process.env.ANTIHALL_CODEX_NUDGE || '').toLowerCase() === 'off') process.exit(0);

  // Escape hatch: shared user-consented skip (~/.anti-hall/skip.json). No inner
  // try/catch — the outer main() try/catch fails OPEN (exit 0) on any skip-guard
  // error, matching speculation-guard so a guard hiccup never causes a block.
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('codex-nudge')) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); }

  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') process.exit(0);

  const scan = scanTranscript(transcriptPath);
  if (!scan) process.exit(0);

  // Not substantial, or Codex already consulted -> nothing to nudge.
  let min = parseInt(process.env.ANTIHALL_CODEX_NUDGE_MIN, 10);
  if (!Number.isFinite(min) || min < 1) min = DEFAULT_MIN;
  if (scan.codeEdits < min) process.exit(0);
  if (scan.codexReview) process.exit(0);

  // Session key (mirror speculation-guard).
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'codex-nudge-state-' + safeSession + '.json');

  // Signature of the edited code-file set -> dedupe (re-nudge only when NEW code files
  // appear), plus a hard per-session cap so churn can't loop us.
  const sig = crypto.createHash('sha1')
    .update(Array.from(scan.codeFiles).sort().join('|')).digest('hex');

  let lastSig = '';
  let nudges = 0;
  try {
    const sraw = fs.readFileSync(stateFile, 'utf8').trim();
    if (sraw) {
      const parsed = JSON.parse(sraw);
      if (parsed && typeof parsed === 'object') {
        lastSig = typeof parsed.sig === 'string' ? parsed.sig : '';
        nudges = Number.isFinite(parsed.nudges) ? parsed.nudges : 0;
      }
    }
  } catch (_) { /* first time */ }

  if (sig === lastSig) process.exit(0);        // same code-file set already nudged
  if (nudges >= MAX_NUDGES) process.exit(0);   // hard cap

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ sig, nudges: nudges + 1 }), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist -> fail-open (don't risk a loop)
  }

  const names = Array.from(scan.codeFiles).slice(0, 3).join(', ');
  const more = scan.codeFiles.size > 3 ? ', …' : '';
  const reason =
    'anti-hall codex-nudge (advisory): this session made ' + scan.codeEdits +
    ' substantial code edit(s) across ' + scan.codeFiles.size + ' file(s) (' + names + more +
    ') with no Codex second opinion. Per the everyday-routing policy, get an independent ' +
    'OpenAI-Codex review of the diff for CORRECTNESS (off-by-one, races, subtle low-level ' +
    'bugs — what Codex catches best) before calling it done: spawn a `codex:codex-rescue` ' +
    'agent (or run /codex:rescue) on the change. Keep planning/architecture review on Opus. ' +
    'Advisory only — if this is trivial, already reviewed, or Codex is unavailable, just ' +
    'continue (set ANTIHALL_CODEX_NUDGE=off to silence).';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0); // fail-open: never wedge a Stop
}
