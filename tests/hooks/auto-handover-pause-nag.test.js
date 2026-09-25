'use strict';
// hooks/auto-handover-pause-nag.js (Stop) — the natural-pause reminder that
// complements hooks/auto-handover.js's fire + milestone nags: repeats at the
// nagQuietMin throttle, stops once usage drops below threshold, and is
// disabled entirely by autoHandover.nag=false (the fire directive itself is
// hooks/auto-handover.js's job, not this file's — tested there).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
const { sessionTag, writeLatch } = require('../../plugins/anti-hall/hooks/lib/auto-handover-state.js');

const HOOK = 'auto-handover-pause-nag.js';
const SESSION = 's1';

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

function pctToTokens(pct) { return Math.round((pct / 100) * 200000); }

function writeUsage(h, pct) {
  const p = h.writeTranscript([]);
  fs.writeFileSync(p, assistantUsageLine(pctToTokens(pct)) + '\n', 'utf8');
  return p;
}

function payload(overrides) {
  return Object.assign({
    hook_event_name: 'Stop', session_id: SESSION, cwd: process.cwd(),
  }, overrides);
}

function firedLatch(extra) {
  return Object.assign({ fired: true, firedAt: Date.now() - 60000, firedPct: 85, lastNagPct: 85, lastNagAt: 0 }, extra);
}

function decision(r) {
  return r.json && r.json.decision === 'block' ? r.json.reason : null;
}

test('nags at a quiet point once fired, over threshold, no open tasks, no recent spawns, past quiet window', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch());
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    const reason = decision(r);
    assert.ok(reason, 'expected a block/reason nag');
    assert.ok(/hallucination/.test(reason));
  } finally {
    h.cleanup();
  }
});

test('does not nag again within the quiet window (nagQuietMin)', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 1000 })); // 1s ago, well under 15 min
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('nags again after the quiet window elapses (repeats at the throttle)', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 })); // 16 min ago > 15 min default
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.ok(decision(r), 'expected a repeat nag past the quiet window');
  } finally {
    h.cleanup();
  }
});

test('stops nagging once usage drops below threshold (and re-arms the latch)', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    const tp = writeUsage(h, 40);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
    const { readLatch } = require('../../plugins/anti-hall/hooks/lib/auto-handover-state.js');
    assert.strictEqual(readLatch(h.home, tag).fired, false);
  } finally {
    h.cleanup();
  }
});

test('disabled by autoHandover.nag=false, even though the latch already fired', () => {
  const h = makeHome();
  try {
    settings.set('autoHandover', 'nag', false, { home: h.home });
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('never nags before the fire directive has gone out (latch not fired; unknown-window pct crossing never fires at Stop)', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 95);
    // Token ceiling explicitly off (it already defaults to off since
    // v0.108.2, but this is set explicitly so the test keeps isolating the
    // pct-against-unknown-window path even if a caller opts a ceiling in
    // elsewhere in the suite).
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: { ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '0' }, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('never nags for a subagent Stop', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp, agent_id: 'sub1', agent_type: 'general-purpose' }),
      { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('never re-blocks when stop_hook_active is true (answering its own block)', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp, stop_hook_active: true }), { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('does not nag while a TodoWrite pending/in_progress task is open', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    const lines = [
      assistantUsageLine(pctToTokens(90)),
      JSON.stringify({
        type: 'assistant', isSidechain: false,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ id: '1', content: 'x', status: 'in_progress' }] } }],
        },
      }),
    ];
    const tp = h.writeTranscript([]);
    fs.writeFileSync(tp, lines.join('\n') + '\n', 'utf8');
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('does not nag while a subagent spawned in the last 2 minutes', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    fs.mkdirSync(h.antiHall, { recursive: true });
    fs.writeFileSync(path.join(h.antiHall, 'agent-spawns.log'), `${Date.now()} ${tag}\n`, 'utf8');
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('does not nag while a TaskCreate/TaskUpdate task is pending/in_progress (not just TodoWrite)', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    const lines = [
      assistantUsageLine(pctToTokens(90)),
      JSON.stringify({
        type: 'assistant', isSidechain: false,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'TaskCreate', input: { subject: 'do the thing', status: 'pending' } }],
        },
      }),
    ];
    const tp = h.writeTranscript([]);
    fs.writeFileSync(tp, lines.join('\n') + '\n', 'utf8');
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('nags once a TaskCreate task is later marked completed via TaskUpdate', () => {
  const h = makeHome();
  try {
    const tag = sessionTag({ session_id: SESSION });
    writeLatch(h.home, tag, firedLatch({ lastNagAt: Date.now() - 16 * 60 * 1000 }));
    const lines = [
      assistantUsageLine(pctToTokens(90)),
      JSON.stringify({
        type: 'assistant', isSidechain: false,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'TaskCreate', input: { subject: 'do the thing', status: 'pending' } }],
        },
      }),
      JSON.stringify({
        type: 'assistant', isSidechain: false,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'TaskUpdate', input: { taskId: 'toolu_1', status: 'completed' } }],
        },
      }),
    ];
    const tp = h.writeTranscript([]);
    fs.writeFileSync(tp, lines.join('\n') + '\n', 'utf8');
    const r = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, expectJson: true });
    assert.ok(decision(r), 'expected the nag once the only tracked task is completed');
  } finally {
    h.cleanup();
  }
});

test('fail-open: malformed stdin -> exit 0, no block', () => {
  const { testHookRaw } = require('../helpers/spawn-hook.js');
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{not json', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

// STOP-SIDE FIRE: a long autonomous turn that never passes UserPromptSubmit
// still gets the fire directive once, at a Stop, via the shared latch.
const KNOWN_WINDOW = { ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' };

test('Stop-side fire: over threshold and never fired -> fire directive once, latch set (UserPromptSubmit then stays quiet)', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 90);
    const r1 = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: KNOWN_WINDOW, expectJson: true });
    assert.match(decision(r1) || '', /AUTO-HANDOVER REQUIRED/);
    const latch = JSON.parse(fs.readFileSync(path.join(h.home, '.anti-hall', 'auto-handover', 's1.json'), 'utf8'));
    assert.strictEqual(latch.fired, true);
    assert.strictEqual(latch.firedVia, 'stop-pct');
    const r2 = testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: KNOWN_WINDOW, expectJson: true });
    assert.doesNotMatch(decision(r2) || '', /AUTO-HANDOVER REQUIRED/, 'fires once per arm');
    const r3 = testHook('auto-handover.js', { hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: 'hi', cwd: process.cwd(), transcript_path: tp },
      { home: h.home, env: Object.assign({ ANTIHALL_EMIT_DEDUPE: '0' }, KNOWN_WINDOW), expectJson: true });
    const ctx = (r3.json && r3.json.hookSpecificOutput && r3.json.hookSpecificOutput.additionalContext) || '';
    assert.doesNotMatch(ctx, /AUTO-HANDOVER REQUIRED/, 'UserPromptSubmit must not fire a second time');
  } finally {
    h.cleanup();
  }
});

test('Stop-side fire: guarded by stop_hook_active', () => {
  const h = makeHome();
  try {
    const tp = writeUsage(h, 90);
    const r = testHook(HOOK, payload({ transcript_path: tp, stop_hook_active: true }), { home: h.home, env: KNOWN_WINDOW, expectJson: true });
    assert.strictEqual(decision(r), null);
  } finally {
    h.cleanup();
  }
});

test('Stop-side fire: never below threshold, never for a subagent, fires even with nag=false', () => {
  const h = makeHome();
  try {
    const low = writeUsage(h, 40);
    assert.strictEqual(decision(testHook(HOOK, payload({ transcript_path: low }), { home: h.home, env: KNOWN_WINDOW, expectJson: true })), null);
    const tp = writeUsage(h, 90);
    assert.strictEqual(decision(testHook(HOOK, payload({ transcript_path: tp, agent_id: 'a1', agent_type: 'x' }), { home: h.home, env: KNOWN_WINDOW, expectJson: true })), null);
    settings.set('autoHandover', 'nag', false, { home: h.home });
    assert.match(decision(testHook(HOOK, payload({ transcript_path: tp }), { home: h.home, env: KNOWN_WINDOW, expectJson: true })) || '', /AUTO-HANDOVER REQUIRED/);
  } finally {
    h.cleanup();
  }
});
