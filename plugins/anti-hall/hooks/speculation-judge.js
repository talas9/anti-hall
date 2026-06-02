#!/usr/bin/env node
// anti-hall :: speculation-judge (Stop hook, OPT-IN semantic tier)
//
// ENABLED ONLY when the environment variable ANTIHALL_SEMANTIC_JUDGE=1 is set.
// When unset (the default), this hook exits 0 immediately without reading
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
//   the last assistant message. It uses the ANTHROPIC_API_KEY environment
//   variable. If that key is absent (or the API call fails for any reason),
//   the hook exits 0 (fail-open) — it never blocks when it cannot verify.
//
// COST / LATENCY
//   One Anthropic API call per Stop event (only when enabled). Expected:
//   ~$0.0001-0.001 per turn at claude-haiku-4-5 rates; ~1-3 s added latency.
//   Enable only if the cost/latency tradeoff is acceptable to you.
//
// OPT-IN
//   Set ANTIHALL_SEMANTIC_JUDGE=1 in your shell profile, .env, or
//   ~/.claude/settings.json env block, then restart Claude Code.
//   To disable: unset the variable (or set it to anything other than "1").
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

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

// ---------------------------------------------------------------------------
// Guard: bail immediately (zero cost) unless explicitly opted in.
// ---------------------------------------------------------------------------
if (process.env.ANTIHALL_SEMANTIC_JUDGE !== '1') {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Judge prompt — conservative: do not block hedging, quoted text,
// hypotheticals, or plans. Only block unverified factual assertions delivered
// with no hedge word and no acknowledgment that they were unverified.
// ---------------------------------------------------------------------------
const JUDGE_SYSTEM = `You are an anti-hallucination evaluator for a coding assistant.
Your job: assess whether the assistant's most recent message contains one or more
UNVERIFIED FACTUAL ASSERTIONS stated with confident, definitive language and NO
acknowledgment that the claim was unverified.

BLOCK if the message asserts a factual claim, a cause, an attribution, or a
metric/log interpretation that:
  - was NOT verified with a tool in that turn (no tool output cited), AND
  - is NOT explicitly flagged as unverified / uncertain, AND
  - is stated CONFIDENTLY (no hedge word like "probably", "likely", "I think",
    "I suspect", "it seems", "it appears", "I'm not sure", "I'd guess", etc.).

DO NOT block:
  - Honest hedging ("I haven't verified this, but...", "I'm not sure, but...",
    "this might be...").
  - Quoted or paraphrased text from the user's own input.
  - Explicit hypotheticals ("if X were the case...", "suppose...").
  - Plans, proposals, or next-steps the assistant says it will do.
  - Claims that are trivially verifiable by inspection of the message itself
    (e.g. describing what a code snippet says, where the snippet is present).
  - Claims prefaced with "I don't know", "I haven't checked", "unverified",
    "let me verify", "I'll check", "need to confirm", or similar.
  - General software/CS knowledge that doesn't depend on this project's state
    (e.g. "HTTP 404 means not found").

Be conservative: when in doubt, ALLOW.

Respond with ONLY valid JSON, no prose, no markdown code fences:
  {"decision":"block","claim":"<one short sentence naming the unverified claim>"}
  or
  {"decision":"allow"}`;

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
function callAnthropicAPI(messageText, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 128,
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: 'Evaluate this assistant message:\n\n' + messageText.slice(0, 8000)
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

  // API key required — fail-open if absent.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    process.exit(0);
  }

  // Derive session key for state file.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');

  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'judge-state-' + safeSession + '.json');

  // Extract last assistant message.
  const lastText = extractLastAssistantText(transcriptPath);
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

  // Call the judge API (20 s timeout — hook budget is 30 s).
  let decision = null;
  try {
    decision = await callAnthropicAPI(lastText, apiKey.trim(), 20000);
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

  const claim = (decision.claim && typeof decision.claim === 'string')
    ? decision.claim.trim()
    : 'an unverified factual claim';

  const reason =
    'anti-hall semantic judge: the reply asserts ' + claim + ' ' +
    'without verifying it this turn and with no hedge or uncertainty acknowledgment. ' +
    'Verify it with a tool, or explicitly flag it as unverified / "I don\'t know — ' +
    'here\'s what I\'d check", then continue.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

main().catch(() => {
  // Fail-open: never wedge a Stop.
  process.exit(0);
});
