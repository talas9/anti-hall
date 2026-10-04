#!/usr/bin/env node
// anti-hall :: speculation-judge (Stop hook, OPT-IN semantic tier)
//
// ENABLED ONLY when the jev.semanticJudge setting is true or the environment
// variable ANTIHALL_SEMANTIC_JUDGE=1 is set (env wins when it is a recognised
// on/off value). When off (the default), this hook exits 0 immediately without reading
// anything, spending any cost, or calling any API. It is safe to register in
// hooks.json for everyone — it only activates for users who explicitly opt in.
//
// PURPOSE
//   The lexical speculation-guard catches hedge-word speculation ("probably",
//   "likely", "I suspect", etc.). It cannot catch a confidently-stated
//   inference-as-fact that uses NO hedge word at all:
//
//     "The cause is the old build artifact." (zero hedging, unverified claim)
//
//   This semantic judge covers that gap by asking a Claude model to evaluate
//   the last assistant message, together with the latest user request and the
//   session's recent tool evidence (lib/inference-check.js collectEvidence), so
//   "verified with a tool" is something the judge can actually see.
//
// BACKENDS (jev.judgeBackend, env ANTIHALL_JUDGE_BACKEND; lib/judge-core.js)
//   api  (default) — Anthropic Messages API with the anthropic_api_key plugin
//        option (CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY; legacy ANTHROPIC_API_KEY
//        only when jev.allowLegacyKeyRead is on). No key -> exit 0.
//   cli  — the local `claude -p` CLI on the user's own Claude login: no key. The
//        child has no tools, no MCP servers, no settings files and all hooks
//        disabled, and gets ANTIHALL_JUDGE_CHILD=1, which makes this hook exit
//        at once if it ever runs inside the child (no recursion).
//   auto — api when a key is visible, else cli.
//   Any failure (no key, CLI missing, timeout, bad reply) -> exit 0 (fail-open).
//
// COST / LATENCY
//   One model call per Stop event (only when enabled). api: ~$0.0001-0.001 per
//   turn at claude-haiku-4-5 rates, ~1-3 s (estimate). cli: no API bill (it uses
//   the Claude login's own usage), ~5-6 s per turn end (measured, claude 2.1.288).
//   Measured precision on eval/inference-bench.js: 0.78-0.81, recall 1.0 (three
//   runs) — why the judge stays opt-in.
//   Enable only if the cost/latency tradeoff is acceptable to you.
//
// OPT-IN
//   Set the jev.semanticJudge setting to true, or set ANTIHALL_SEMANTIC_JUDGE=1
//   in your shell profile, .env, or ~/.claude/settings.json env block.
//   To disable: set the setting to false and unset the variable (an explicit
//   ANTIHALL_SEMANTIC_JUDGE=0 overrides a true setting).
//
// LOOP-SAFE
//   Hashes the last assistant message text + "judge" suffix. Stores the
//   blocked hash in ~/.anti-hall/judge-state-<session>.json. If the same
//   hash was already blocked (nothing changed), exits 0 — the model was
//   nudged once; it had a chance to respond. Never wedges.
//
// FAIL-OPEN
//   Any error (parse error, missing transcript, API unavailable, API key
//   absent, timeout, non-2xx response, JSON decode error) exits 0 silently.
//   A bug here must never wedge a session.
//
// MISFIRE NOTE
//   LLM judges can produce false positives on quoted text, hypotheticals,
//   and plan descriptions. The judge prompt instructs conservative evaluation
//   and allows honest hedging, but some misfires will occur. See README for
//   how to tune or disable per-session.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { transcript_path, session_id?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing
//   exit 0 : always

'use strict';
require('./lib/judge-child-exit');

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('./lib/lazy-node.js').crypto; // lazy: loaded on first hash
const https = require('https');

// ---------------------------------------------------------------------------
// Guard: bail immediately (zero cost) unless explicitly opted in.
// ---------------------------------------------------------------------------
// The jev.semanticJudge setting (schema env: ANTIHALL_SEMANTIC_JUDGE, env wins
// over settings.json) enables it; default OFF; any lookup error -> OFF.
// A judge call made through the CLI backend never judges itself.
if (process.env.ANTIHALL_JUDGE_CHILD === '1') process.exit(0);
let judgeEnabled = false;
try { judgeEnabled = require('./lib/settings.js').get('jev', 'semanticJudge') === true; } catch (_) { /* stay off */ }
if (!judgeEnabled) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Judge prompt + input + CLI backend: lib/judge-core.js (shared with
// eval/inference-bench.js, so the eval measures exactly what ships).
// ---------------------------------------------------------------------------
const judgeCore = require('./lib/judge-core.js');
const JUDGE_SYSTEM = judgeCore.JUDGE_SYSTEM;

// ---------------------------------------------------------------------------
// Extract the last assistant message text from a transcript JSONL file.
// Returns null on any error or if no assistant message is found.
// (Same extraction logic as speculation-guard.js for consistency.)
// ---------------------------------------------------------------------------
function collectTextFromEntry(node) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];
  if (typeof node.text === 'string') {
    parts.push(node.text);
  }
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
  if (node.message && typeof node.message === 'object' && node.message !== node) {
    const sub = collectTextFromEntry(node.message);
    if (sub) parts.push(sub);
  }
  return parts.join(' ');
}

// Bounded tail read: load only the last `windowBytes` (default 512 KB) of a
// possibly multi-GB transcript instead of the whole file, so a huge transcript
// can never OOM or stall this hook. The last assistant message is at the end of
// the JSONL, so the trailing window is sufficient; if the file is smaller than
// the window we read it all. Any error -> null (caller fails open).
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
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function extractLastAssistantText(transcriptPath) {
  const tail = readTranscriptTail(transcriptPath);
  if (!tail) {
    return null;
  }
  const lines = tail.data.split(/\r?\n/);
  // The first line of a mid-file window may be a truncated partial; drop it.
  if (tail.truncated && lines.length > 0) {
    lines.shift();
  }
  let lastText = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch (_) { continue; }
    const role = entry && (entry.role || (entry.message && entry.message.role));
    if (role !== 'assistant') continue;
    const text = collectTextFromEntry(entry);
    if (text) lastText = text;
  }
  return lastText;
}

// ---------------------------------------------------------------------------
// Call the Anthropic API (Messages endpoint) with a timeout.
// Returns the judge's decision object or null on any failure.
// ---------------------------------------------------------------------------
// judgeModel() -> jev.judgeModel via the settings precedence chain (env
// ANTIHALL_JUDGE_MODEL > settings.json > /config > default), fail-open to the
// historical env-or-default read.
function judgeModel() {
  try { return String(require('./lib/settings.js').get('jev', 'judgeModel') || '').trim() || 'claude-haiku-4-5'; }
  catch (_) { return process.env.ANTIHALL_JUDGE_MODEL || 'claude-haiku-4-5'; }
}

function callAnthropicAPI(judgeInput, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: judgeModel(),
      max_tokens: 128,
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: judgeInput
        }
      ]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    };

    let timedOut = false;
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (timedOut) return;
        try {
          const parsed = JSON.parse(raw);
          // Extract text from content blocks
          let text = '';
          if (Array.isArray(parsed.content)) {
            for (const block of parsed.content) {
              if (block && block.type === 'text' && typeof block.text === 'string') {
                text += block.text;
              }
            }
          }
          // Strip markdown code fences if the model wrapped the JSON
          text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          const decision = JSON.parse(text);
          resolve(decision);
        } catch (_) {
          resolve(null);
        }
      });
    });

    req.on('error', () => { if (!timedOut) resolve(null); });

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      resolve(null);
    }, timeoutMs);

    // Clear timer when request ends normally
    req.on('close', () => { clearTimeout(timer); });

    req.write(body);
    req.end();
  });
}

// sanitizeClaim — the judge's echoed claim is model-produced and reflected into
// the block reason the model reads next turn. Strip C0/C1 control chars +
// newlines, collapse whitespace, and truncate so it can't inject instruction-like
// lines into the reason. Mirrors tasklist-guard.sanitizeReason.
function sanitizeClaim(s) {
  if (typeof s !== 'string') return 'an unverified factual claim';
  let out = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    // Unicode bidi overrides (U+202A–U+202E) + isolates (U+2066–U+2069): strip
    // entirely so they cannot visually reorder the reflected reason.
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!out) return 'an unverified factual claim';
  if (out.length > 120) out = out.slice(0, 120).trimEnd() + '…';
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Read stdin
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('speculation-judge')) process.exit(0);

  // Avoid double-paying: when Jev's own speculation classifier is fully
  // trusted (jev.json integrations.speculation === "on", or legacy
  // {"enabled":true} with no override), speculation-guard.js already covers
  // this same "unverified assertion" gap for free (it runs first, on every
  // Stop, via the fast lexical/Jev path below in this file's sibling hook).
  // Paying for a second, slower, billed Haiku call on top of that adds cost
  // without meaningfully improving coverage. "shadow"/"off" modes still run
  // the Haiku judge as before (Jev isn't trusted yet or is disabled).
  try {
    const { getMode } = require('./lib/jev-assist.js');
    const { loadJevConfig } = require('./lib/jev-client.js');
    const jevCfg = loadJevConfig();
    if (jevCfg.enabled) {
      let fileCfg = {};
      try {
        fileCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.anti-hall', 'jev.json'), 'utf8'));
      } catch (_) { fileCfg = {}; }
      if (getMode('speculation', fileCfg) === 'on') process.exit(0);
    }
  } catch (_) {
    // Can't determine Jev's mode -> fall through and run the Haiku judge as before.
  }

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

  // Backend: api needs a key (fail-open without one); cli needs none; auto
  // picks api when a key is visible.
  let backend = 'api';
  try { backend = require('./lib/settings.js').get('jev', 'judgeBackend') || 'api'; } catch (_) { backend = 'api'; }
  let apiKey = null;
  try { apiKey = require('./lib/credentials.js').resolveKey('anthropic').key; } catch (_) { apiKey = null; }
  const hasKey = !!(apiKey && typeof apiKey === 'string' && apiKey.trim());
  if (backend === 'auto') backend = hasKey ? 'api' : 'cli';
  if (backend !== 'cli' && !hasKey) {
    process.exit(0);
  }

  // Derive session key for state file.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');

  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'judge-state-' + safeSession + '.json');

  // The reply being stopped: the Stop payload's `last_assistant_message` wins
  // (the transcript tail can still end at the PREVIOUS turn at Stop time);
  // the transcript extractor is only the fallback (lib/reply-text.js). If the
  // helper cannot load, use the transcript extractor as before.
  let lastText;
  try {
    lastText = require('./lib/reply-text.js').selectReplyText(
      payload, () => extractLastAssistantText(transcriptPath));
  } catch (_) {
    lastText = extractLastAssistantText(transcriptPath);
  }
  if (!lastText || !lastText.trim()) {
    process.exit(0);
  }

  // Compute hash for loop-safety. Use a "judge" suffix to keep the namespace
  // separate from speculation-guard's hash space (different tier, different
  // block granularity).
  const msgHash = crypto.createHash('sha1').update(lastText + ':judge').digest('hex');

  // Load prior state — skip if already blocked on this exact message. Also read
  // a running block count (default 0); tolerate a legacy bare-hash string.
  let blocks = 0;
  try {
    const stateRaw = fs.readFileSync(stateFile, 'utf8').trim();
    if (stateRaw) {
      const parsed = JSON.parse(stateRaw);
      const lastBlockedHash = (parsed && typeof parsed.hash === 'string') ? parsed.hash : '';
      if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.blocks)) {
        blocks = parsed.blocks;
      }
      if (msgHash === lastBlockedHash) {
        process.exit(0);
      }
    }
  } catch (_) {
    // No prior state — first time.
  }

  // Loop-safety 2: hard cap on total blocks this session. The message text
  // legitimately changes as the model reworks its reply, which defeats the
  // byte-identical hash dedupe; without a cap we could re-block on every Stop.
  // After MAX_BLOCKS nudges we stay quiet regardless of churn.
  const MAX_BLOCKS = 3;
  if (blocks >= MAX_BLOCKS) {
    process.exit(0);
  }

  // What the judge sees besides the reply: the latest user request and the
  // tool evidence in the transcript tail. Missing -> judged on the reply alone.
  let evidence = [];
  let userRequest = '';
  try {
    const tail = readTranscriptTail(transcriptPath, 1024 * 1024);
    if (tail) {
      const lines = tail.data.split(/\r?\n/);
      if (tail.truncated) lines.shift();
      const ic = require('./lib/inference-check.js');
      evidence = ic.collectEvidence(lines, { raw: true });
      userRequest = ic.lastUserPrompt(lines);
    }
  } catch (_) { evidence = []; userRequest = ''; }
  const judgeInput = judgeCore.buildJudgeInput(lastText, evidence, userRequest);

  // Call the judge (api: 20 s, cli: 25 s — the hook budget is 30 s).
  let decision = null;
  try {
    decision = backend === 'cli'
      ? await judgeCore.runCliJudge({ input: judgeInput, model: judgeModel(), timeoutMs: 25000 })
      : await callAnthropicAPI(judgeInput, apiKey.trim(), 20000);
  } catch (_) {
    process.exit(0);
  }

  // Fail-open: null, non-object, missing decision field, or "allow" all exit 0.
  if (!decision || typeof decision !== 'object') {
    process.exit(0);
  }
  if (decision.decision !== 'block') {
    process.exit(0);
  }

  // Persist the blocked hash + incremented count before emitting the decision.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hash: msgHash, blocks: blocks + 1 }), 'utf8');
  } catch (_) {
    // Cannot persist state — fail-open to avoid a potential loop.
    process.exit(0);
  }

  // Sanitize the judge's echoed claim before reflecting it into the reason: it
  // originates from a model and could carry control chars / newlines that inject
  // instruction-like lines. Strip C0/C1 controls + newlines, collapse whitespace,
  // and truncate. Mirrors tasklist-guard's sanitizeReason / task-guard's
  // sanitizeSubject hygiene.
  const claim = sanitizeClaim(
    (decision.claim && typeof decision.claim === 'string')
      ? decision.claim
      : 'an unverified factual claim'
  );

  const reason = require('./lib/block-message.js').blockMessage({
    guard: 'speculation-judge',
    what: 'your reply states \'' + claim + '\' as fact, but nothing this session checked shows it and it is not flagged as unverified.',
    why: 'Unverified claims read as facts.',
    instead: 'verify it with a tool, or say what is unverified (\'I don\'t know, here is what I would check\'), then continue.',
  });

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

main().catch(() => {
  // Fail-open: never wedge a Stop.
  process.exit(0);
});
