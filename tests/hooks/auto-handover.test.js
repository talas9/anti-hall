'use strict';
// hooks/auto-handover.js (UserPromptSubmit) — fires once at >=85% for the main
// thread, never for a subagent, never below threshold, re-arms after a drop,
// respects env override/off, and sends a milestone nag as usage keeps growing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, HOOKS_DIR } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'auto-handover.js';
// Most of these tests exercise fire/latch/milestone/threshold behavior, not
// the window-known-vs-unknown gating itself (see the dedicated tests near the
// bottom of this file) — an explicit ANTIHALL_CONTEXT_WINDOW_TOKENS keeps the
// window KNOWN so the mandatory directive fires as these tests expect,
// instead of the soft advisory a genuinely unknown window now produces.
const NO_DEDUPE = { ANTIHALL_EMIT_DEDUPE: '0', ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' };

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

function assistantUsageLine(usedTokens) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: usedTokens },
    },
  });
}

// pctToTokens: usedTokens against the default 200000 window that yields the
// given percent.
function pctToTokens(pct) {
  return Math.round((pct / 100) * 200000);
}

function writeUsage(h, pct) {
  const p = h.writeTranscript([]);
  fs.writeFileSync(p, assistantUsageLine(pctToTokens(pct)) + '\n', 'utf8');
  return p;
}

function payload(overrides) {
  return Object.assign({
    hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi', cwd: process.cwd(),
  }, overrides);
}

test('fires once at >=85% for the main thread', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r)), `expected fire directive; got: ${ctx(r)}`);
    assert.ok(/hallucination/.test(ctx(r)), 'expected the context-bloat sentence');
  } finally {
    h.cleanup();
  }
});

test('does not fire twice for the same crossing (latch)', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 90);
    const r1 = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r1)));
    const r2 = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(ctx(r2), '', `expected no re-fire; got: ${ctx(r2)}`);
  } finally {
    h.cleanup();
  }
});

test('never fires for a subagent turn (agent_id present)', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 95);
    const r = testHook(HOOK, payload({ transcript_path: tp, agent_id: 'sub1', agent_type: 'general-purpose' }),
      { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(ctx(r), '');
  } finally {
    h.cleanup();
  }
});

test('does not fire below threshold', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 50);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(ctx(r), '');
  } finally {
    h.cleanup();
  }
});

test('re-arms after usage drops back below threshold, then fires again on a later crossing', () => {
  const h = makeHome();
  try {
    const tp1 = writeUsage(h, 90);
    const r1 = testHook(HOOK, payload({ transcript_path: tp1 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r1)));

    // A compact/clear drops usage back down (new/rewritten transcript).
    const tp2 = writeUsage(h, 20);
    const r2 = testHook(HOOK, payload({ transcript_path: tp2 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(ctx(r2), '');

    const tp3 = writeUsage(h, 88);
    const r3 = testHook(HOOK, payload({ transcript_path: tp3 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r3)), 'expected a fresh fire after re-arming');
  } finally {
    h.cleanup();
  }
});

test('env ANTIHALL_AUTO_HANDOVER_PCT overrides the threshold', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 65);
    const r = testHook(HOOK, payload({ transcript_path: tp }),
      { home: h.home, env: Object.assign({ ANTIHALL_AUTO_HANDOVER_PCT: '60' }, NO_DEDUPE), expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r)), `expected fire at 65% with threshold 60; got: ${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('env ANTIHALL_AUTO_HANDOVER_PCT=0 disables the feature entirely', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 99);
    const r = testHook(HOOK, payload({ transcript_path: tp }),
      { home: h.home, env: Object.assign({ ANTIHALL_AUTO_HANDOVER_PCT: '0' }, NO_DEDUPE), expectJson: true });
    assert.strictEqual(ctx(r), '');
  } finally {
    h.cleanup();
  }
});

test('fail-open: missing/unreadable transcript -> empty context, never throws', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload({ transcript_path: path.join(h.home, 'nope.jsonl') }),
      { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '');
  } finally {
    h.cleanup();
  }
});

test('fail-open: malformed stdin -> empty context, exit 0', () => {
  const { testHookRaw } = require('../helpers/spawn-hook.js');
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{not json', { home: h.home, env: NO_DEDUPE });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('milestone nag fires once usage grows nagStepPct past the fire point, not before', () => {
  const h = makeHome();
  try {
    const tp1 = writeUsage(h, 85);
    const r1 = testHook(HOOK, payload({ transcript_path: tp1 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r1)));

    // Still under the +5 default step -> no nag.
    const tp2 = writeUsage(h, 88);
    const r2 = testHook(HOOK, payload({ transcript_path: tp2 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(ctx(r2), '', `expected no nag yet; got: ${ctx(r2)}`);

    // Past the step -> a short nag, NOT the full fire directive again.
    const tp3 = writeUsage(h, 91);
    const r3 = testHook(HOOK, payload({ transcript_path: tp3 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.ok(/CONTEXT NOW/.test(ctx(r3)), `expected milestone nag; got: ${ctx(r3)}`);
    assert.ok(!/AUTO-HANDOVER REQUIRED/.test(ctx(r3)));
  } finally {
    h.cleanup();
  }
});

test('nag:false in settings silences the milestone nag but the initial fire still happens', () => {
  const h = makeHome();
  try {
    const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
    settings.set('autoHandover', 'nag', false, { home: h.home });

    const tp1 = writeUsage(h, 85);
    const r1 = testHook(HOOK, payload({ transcript_path: tp1 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r1)));

    const tp2 = writeUsage(h, 95);
    const r2 = testHook(HOOK, payload({ transcript_path: tp2 }), { home: h.home, env: NO_DEDUPE, expectJson: true });
    assert.strictEqual(ctx(r2), '', `expected no nag with nag:false; got: ${ctx(r2)}`);
  } finally {
    h.cleanup();
  }
});

// --- window-known gating (P1 hardening: never fire the mandatory directive
// from an estimate whose window is genuinely unknown) --------------------

const DEDUPE_ONLY = { ANTIHALL_EMIT_DEDUPE: '0' }; // deliberately WITHOUT ANTIHALL_CONTEXT_WINDOW_TOKENS

test('unknown window (no statusline, no env, usage never exceeded 200k) -> soft advisory, NOT the mandatory directive', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 90); // 90% of the assumed 200k -> 180000 tokens, well under 200000
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: DEDUPE_ONLY, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(!/AUTO-HANDOVER REQUIRED/.test(ctx(r)), `must not fire the mandatory directive; got: ${ctx(r)}`);
    assert.ok(/soft heads-up/.test(ctx(r)), `expected the soft advisory; got: ${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('unknown window: the soft advisory fires only once per arm, not every turn', () => {
  const h = makeHome();
  try {
    const tp1 = writeUsage(h, 90);
    const r1 = testHook(HOOK, payload({ transcript_path: tp1 }), { home: h.home, env: DEDUPE_ONLY, expectJson: true });
    assert.ok(/soft heads-up/.test(ctx(r1)));
    const tp2 = writeUsage(h, 92);
    const r2 = testHook(HOOK, payload({ transcript_path: tp2 }), { home: h.home, env: DEDUPE_ONLY, expectJson: true });
    assert.strictEqual(ctx(r2), '', `expected silence on the second unknown-window turn; got: ${ctx(r2)}`);
  } finally {
    h.cleanup();
  }
});

test('observed usage exceeding 200k with no known window -> inferred 1M latch, mandatory directive DOES fire', () => {
  const h = makeHome();
  try {
    // 900000 tokens: > the 200000 standard window (proves the window isn't
    // 200k) AND >= 85% of the inferred 1,000,000 window, so it also crosses
    // the fire threshold under that inferred window.
    const p = h.writeTranscript([]);
    fs.writeFileSync(p, assistantUsageLine(900000) + '\n', 'utf8');

    const r = testHook(HOOK, payload({ transcript_path: p }), { home: h.home, env: DEDUPE_ONLY, expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r)), `expected the mandatory directive; got: ${ctx(r)}`);
    assert.ok(/inferred 1M window/.test(ctx(r)), `expected the inferred-1m label; got: ${ctx(r)}`);

    const store = require('../../plugins/anti-hall/hooks/lib/context-pct-store.js');
    const tag = store.tagFromSessionId('s1');
    assert.strictEqual(store.readInferred1m(h.home, tag), true, 'expected the inferred-1m latch to persist');
  } finally {
    h.cleanup();
  }
});

test('a KNOWN window (ANTIHALL_CONTEXT_WINDOW_TOKENS) fires the mandatory directive normally, no soft-advisory wording', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp }),
      { home: h.home, env: Object.assign({ ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' }, DEDUPE_ONLY), expectJson: true });
    assert.ok(/AUTO-HANDOVER REQUIRED/.test(ctx(r)));
    assert.ok(!/soft heads-up/.test(ctx(r)));
  } finally {
    h.cleanup();
  }
});
