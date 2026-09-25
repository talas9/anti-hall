#!/usr/bin/env node
// anti-hall :: jev-triage-worker — the async half of mesh message triage.
//
// This file does the actual network I/O (Jev, and a Haiku fallback) for
// jev-triage.js's synchronous `triageMessagesSync`. It is NEVER invoked
// directly by a user; jev-triage.js spawns it (execFileSync, with its own
// hard `timeout`) so the rest of the mesh CLI/hooks — both fully synchronous,
// 16k+ lines of established sync call chains — never has to become async to
// get one advisory classification.
//
// Contract:
//   stdin  : JSON { items: [{hash, text}], timeoutMs, urgentThreshold }
//   stdout : JSON { <hash>: {urgency?, kind?, backend, ms, confidence?} }
//            (a hash with NEITHER label resolved is simply omitted)
//   exit   : always 0. Any error -> best-effort partial results, never throws
//            past main(). The PARENT (jev-triage.js) additionally treats a
//            spawn timeout/non-zero exit/unparsable stdout as "no results" —
//            fail-open at every layer.
//
// PRIVACY: never logs, prints, or echoes an API key. Only reads it via
// jev-client.js's own resolveCredential (same key-hygiene contract).

'use strict';

const https = require('https');

const KIND_QUESTION = {
  type: 'choice',
  instructions:
    'Classify this mesh message by what kind of response, if any, it needs from ' +
    'the recipient.',
  criteria: {
    'question-needs-answer': 'The message asks the recipient a direct question ' +
      'that requires a reply before the sender can proceed.',
    'blocker': 'The message reports something actively blocking progress that ' +
      'the recipient needs to act on or unblock.',
    'status-report': 'The message is a routine progress/status update, not ' +
      'blocked and not asking anything.',
    'done-report': 'The message reports that a task or piece of work is ' +
      'complete/finished.',
    'fyi': 'The message is purely informational — nothing is being asked and ' +
      'nothing is blocked or finished.',
  },
};

const URGENCY_QUESTION = {
  type: 'noul',
  instructions:
    'Does this mesh message require URGENT, immediate attention — a blocker, or ' +
    'a question the recipient must answer before the sender can proceed — as ' +
    'opposed to something that can wait for a normal turn?',
  criteria: {
    true: 'The message is a live blocker or an unanswered question gating the ' +
      'sender\'s progress; it needs a reply or action right away.',
    false: 'The message is a routine status update, a done-report, an FYI, or ' +
      'anything else that can wait for the recipient\'s normal cadence.',
  },
};

const HAIKU_SYSTEM = `You triage one internal coordination message between two AI agent workspaces.
Classify it on two axes.

kind — exactly one of:
  question-needs-answer: asks the recipient a direct question requiring a reply
  blocker: reports something actively blocking progress the recipient must act on
  status-report: a routine progress update, not blocked, not asking anything
  done-report: reports a task/work item is complete
  fyi: purely informational, nothing asked, nothing blocked or finished

urgency — exactly one of:
  urgent: a live blocker or unanswered question gating the sender's progress
  normal: anything else (status/done/fyi, or a question that is not gating)

Respond with ONLY valid JSON, no prose, no markdown fences:
  {"kind":"<one of the five kind values>","urgency":"urgent"|"normal"}`;

// judgeModel() -> jev.judgeModel via the settings precedence chain (env
// ANTIHALL_JUDGE_MODEL > settings.json > /config > default), fail-open to the
// historical env-or-default read.
function judgeModel() {
  try { return String(require('./settings.js').get('jev', 'judgeModel') || '').trim() || 'claude-haiku-4-5'; }
  catch (_) { return process.env.ANTIHALL_JUDGE_MODEL || 'claude-haiku-4-5'; }
}

function callHaiku(text, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: judgeModel(),
      max_tokens: 64,
      system: HAIKU_SYSTEM,
      messages: [{ role: 'user', content: 'Message:\n\n' + String(text).slice(0, 4000) }],
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };
    let timedOut = false;
    const start = Date.now();
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (timedOut) return;
        try {
          const parsed = JSON.parse(raw);
          let out = '';
          if (Array.isArray(parsed.content)) {
            for (const b of parsed.content) {
              if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
            }
          }
          out = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          const decision = JSON.parse(out);
          resolve({ decision, ms: Date.now() - start });
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => { if (!timedOut) resolve(null); });
    const timer = setTimeout(() => { timedOut = true; req.destroy(); resolve(null); }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

const VALID_KINDS = new Set([
  'question-needs-answer', 'blocker', 'status-report', 'done-report', 'fyi',
]);

async function classifyOne(text, deadline, jevCfg, urgentThreshold, jevDecideMulti) {
  const out = {};
  let backendUsed = null;

  const remaining = deadline - Date.now();
  if (jevCfg.enabled && remaining > 50) {
    try {
      const result = await jevDecideMulti({
        questions: { kind: KIND_QUESTION, urgency: URGENCY_QUESTION },
        state: String(text).slice(0, 4000),
        timeoutMs: Math.max(50, Math.min(remaining, jevCfg.timeoutMs)),
      });
      if (result.ok) {
        const kindAns = result.answers.kind;
        if (kindAns && kindAns.ok && kindAns.confidence >= jevCfg.confidenceThreshold &&
          VALID_KINDS.has(kindAns.answer)) {
          out.kind = kindAns.answer;
        }
        const urgAns = result.answers.urgency;
        if (urgAns && urgAns.ok) {
          // Known Jev weakness: over-flags "urgent" (measured 67.6% precision on
          // an easy benchmark set — see docs/KB-jev-classifier.md §7/§8). A
          // STRICTER threshold than the ordinary confidenceThreshold is required
          // to call something urgent; the (much more common) "normal" verdict
          // uses the ordinary threshold.
          if (urgAns.answer === true && urgAns.confidence >= urgentThreshold) {
            out.urgency = 'urgent';
          } else if (urgAns.answer === false && urgAns.confidence >= jevCfg.confidenceThreshold) {
            out.urgency = 'normal';
          }
        }
        out.ms = result.ms;
        if (out.kind || out.urgency) backendUsed = 'jev';
      }
    } catch (_) {
      // fall through to haiku
    }
  }

  const needsHaiku = !out.kind || !out.urgency;
  if (needsHaiku) {
    const remaining2 = deadline - Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && typeof apiKey === 'string' && apiKey.trim() && remaining2 > 50) {
      try {
        const haiku = await callHaiku(text, apiKey.trim(), Math.max(50, remaining2));
        if (haiku && haiku.decision) {
          const d = haiku.decision;
          if (!out.kind && typeof d.kind === 'string' && VALID_KINDS.has(d.kind)) {
            out.kind = d.kind;
          }
          if (!out.urgency && (d.urgency === 'urgent' || d.urgency === 'normal')) {
            out.urgency = d.urgency;
          }
          out.ms = (out.ms || 0) + haiku.ms;
          backendUsed = backendUsed ? backendUsed + '+haiku' : 'haiku';
        }
      } catch (_) {
        // no label from haiku either — fine, fail-open
      }
    }
  }

  if (!out.kind && !out.urgency) return null;
  return { urgency: out.urgency, kind: out.kind, backend: backendUsed || 'unknown', ms: out.ms || 0 };
}

async function main() {
  let raw = '';
  try {
    raw = require('fs').readFileSync(0, 'utf8');
  } catch (_) {
    process.stdout.write('{}');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.stdout.write('{}');
    return;
  }
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const timeoutMs = Number.isFinite(payload && payload.timeoutMs) && payload.timeoutMs > 0
    ? payload.timeoutMs : 2000;
  const urgentThreshold = Number.isFinite(payload && payload.urgentThreshold) &&
    payload.urgentThreshold >= 0 && payload.urgentThreshold <= 1
    ? payload.urgentThreshold : 0.9;

  const deadline = Date.now() + timeoutMs;
  const results = {};

  let jevDecideMulti = null;
  let loadJevConfig = null;
  try {
    const jc = require('./jev-client.js');
    jevDecideMulti = jc.jevDecideMulti;
    loadJevConfig = jc.loadJevConfig;
  } catch (_) {
    // jev-client unavailable -> Jev path stays off; Haiku fallback (below) can
    // still run per item.
  }
  const jevCfg = loadJevConfig ? loadJevConfig() : { enabled: false, timeoutMs: 1500, confidenceThreshold: 0.85 };

  for (const item of items) {
    if (Date.now() >= deadline - 50) break; // out of budget: leave the rest unlabeled
    if (!item || typeof item.hash !== 'string' || typeof item.text !== 'string' || !item.text.trim()) {
      continue;
    }
    try {
      const label = await classifyOne(item.text, deadline, jevCfg, urgentThreshold, jevDecideMulti || (async () => ({ ok: false, reason: 'unavailable' })));
      if (label) results[item.hash] = label;
    } catch (_) {
      // this item gets no label; keep going for the rest within budget
    }
  }

  try {
    process.stdout.write(JSON.stringify(results));
  } catch (_) {
    // nothing more we can do
  }
}

main().catch(() => {
  try { process.stdout.write('{}'); } catch (_) { /* noop */ }
});
