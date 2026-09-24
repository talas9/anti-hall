'use strict';
// context-pct.js — the transcript-usage estimate consumed by hooks/auto-handover.js
// and hooks/auto-handover-pause-nag.js.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');
const { getContextPct } = require('../../plugins/anti-hall/hooks/lib/context-pct.js');
const store = require('../../plugins/anti-hall/hooks/lib/context-pct-store.js');

function assistantUsageLine(usage, opts) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: (opts && opts.sidechain) === true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage },
  });
}

test('getContextPct: computes pct from input+cache tokens against the default 200000 window', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 99000,
    }) + '\n', 'utf8');
    const r = getContextPct(p, {});
    assert.ok(r, 'expected a result');
    assert.strictEqual(r.used, 100002);
    assert.strictEqual(r.max, 200000);
    assert.ok(Math.abs(r.pct - 50.001) < 0.01, `pct was ${r.pct}`);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: ANTIHALL_CONTEXT_WINDOW_TOKENS overrides the default max', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 500000,
    }) + '\n', 'utf8');
    const r = getContextPct(p, { ANTIHALL_CONTEXT_WINDOW_TOKENS: '1000000' });
    assert.ok(r);
    assert.strictEqual(r.max, 1000000);
    assert.strictEqual(r.pct, 50);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: ignores a sidechain (subagent) usage entry and uses the last MAIN-thread one', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    const lines = [
      assistantUsageLine({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000 }),
      assistantUsageLine({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 999999 }, { sidechain: true }),
    ];
    require('fs').writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    const r = getContextPct(p, {});
    assert.ok(r);
    assert.strictEqual(r.used, 10001);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: missing transcript -> null (fail-open)', () => {
  const r = getContextPct(path.join('/nonexistent', 'transcript.jsonl'), {});
  assert.strictEqual(r, null);
});

test('getContextPct: null/absent transcript path -> null', () => {
  assert.strictEqual(getContextPct(null, {}), null);
  assert.strictEqual(getContextPct(undefined, {}), null);
});

test('getContextPct: malformed JSON lines and lines with no usage are skipped, not fatal', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    const body = [
      '{not json',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }), // no usage
      assistantUsageLine({ input_tokens: 5, cache_creation_input_tokens: 5, cache_read_input_tokens: 90 }),
    ].join('\n') + '\n';
    require('fs').writeFileSync(p, body, 'utf8');
    const r = getContextPct(p, {});
    assert.ok(r);
    assert.strictEqual(r.used, 100);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: pct is clamped to [0, 100]', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000000,
    }) + '\n', 'utf8');
    const r = getContextPct(p, {});
    assert.ok(r);
    assert.strictEqual(r.pct, 100);
  } finally {
    h.cleanup();
  }
});

// --- source preference: statusline (real figure) vs transcript (estimate) --

test('getContextPct: prefers a FRESH statusline reading over the transcript, correctly reflecting a 1M window', () => {
  const h = makeHome();
  try {
    // A 1M-context session: the transcript-only estimate (default 200k) would
    // wildly overstate this — 500000/200000 clamped to 100%. The real
    // statusline figure (17% of a 1M window) must win.
    store.write(h.home, 'sess-1m', { pct: 17, usedTokens: 170000, maxTokens: 1000000 });
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 500000,
    }) + '\n', 'utf8');

    const r = getContextPct(p, {}, { home: h.home, sessionId: 'sess-1m' });
    assert.ok(r);
    assert.strictEqual(r.source, 'statusline');
    assert.strictEqual(r.estimated, false);
    assert.strictEqual(r.pct, 17);
    assert.strictEqual(r.max, 1000000);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: a STALE statusline reading (>10 min) is ignored, falls back to the transcript estimate', () => {
  const h = makeHome();
  try {
    store.write(h.home, 'sess-1', { pct: 99, usedTokens: 1, maxTokens: 2 }, Date.now() - 11 * 60 * 1000);
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000,
    }) + '\n', 'utf8');

    const r = getContextPct(p, {}, { home: h.home, sessionId: 'sess-1' });
    assert.ok(r);
    assert.strictEqual(r.source, 'estimate');
    assert.strictEqual(r.estimated, true);
    assert.strictEqual(r.max, 200000); // default, not the stale statusline's max
  } finally {
    h.cleanup();
  }
});

test('getContextPct: no sessionId -> skips the statusline lookup entirely, still returns the transcript estimate', () => {
  const h = makeHome();
  try {
    store.write(h.home, 'sess-1', { pct: 99, usedTokens: 1, maxTokens: 2 });
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000,
    }) + '\n', 'utf8');

    const r = getContextPct(p, {}, { home: h.home }); // sessionId omitted
    assert.ok(r);
    assert.strictEqual(r.source, 'estimate');
    assert.strictEqual(r.pct, 10);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: transcript estimate honors ANTIHALL_CONTEXT_WINDOW_TOKENS when no statusline reading exists', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 170000,
    }) + '\n', 'utf8');

    const r = getContextPct(p, { ANTIHALL_CONTEXT_WINDOW_TOKENS: '1000000' }, { home: h.home, sessionId: 'sess-1m-manual' });
    assert.ok(r);
    assert.strictEqual(r.source, 'estimate');
    assert.strictEqual(r.estimated, true);
    assert.strictEqual(r.max, 1000000);
    assert.strictEqual(r.pct, 17);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: neither source available -> null', () => {
  const h = makeHome();
  try {
    const r = getContextPct(require('node:path').join(h.home, 'nope.jsonl'), {}, { home: h.home, sessionId: 'sess-none' });
    assert.strictEqual(r, null);
  } finally {
    h.cleanup();
  }
});
