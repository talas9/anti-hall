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

test('getContextPct: a STALE statusline PCT (>10 min) is ignored, but its maxTokens is used STICKILY (idle-gap fix)', () => {
  const h = makeHome();
  try {
    // A real statusline reading from earlier this session recorded a 1M
    // window; the statusline just hasn't rendered in the last 10 minutes.
    // The window size does not change because of that idle gap — the
    // transcript-usage estimate must still use the REAL 1M window, not fall
    // back to guessing 200k (the old idle-gap bug this fixes).
    store.write(h.home, 'sess-1', { pct: 40, usedTokens: 400000, maxTokens: 1000000 }, Date.now() - 11 * 60 * 1000);
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 500000,
    }) + '\n', 'utf8');

    const r = getContextPct(p, {}, { home: h.home, sessionId: 'sess-1' });
    assert.ok(r);
    assert.strictEqual(r.source, 'estimate');
    assert.strictEqual(r.estimated, true);
    assert.strictEqual(r.windowLabel, 'sticky');
    assert.strictEqual(r.windowKnown, true);
    assert.strictEqual(r.max, 1000000); // sticky, not the 200000 default
    assert.strictEqual(r.pct, 50);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: genuinely UNKNOWN window (no statusline ever, no env, usage under 200k) -> default 200k but windowKnown:false', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    require('fs').writeFileSync(p, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000,
    }) + '\n', 'utf8');

    const r = getContextPct(p, {}, { home: h.home, sessionId: 'sess-never-seen' });
    assert.ok(r);
    assert.strictEqual(r.source, 'estimate');
    assert.strictEqual(r.windowLabel, 'default');
    assert.strictEqual(r.windowKnown, false);
    assert.strictEqual(r.max, 200000);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: observed usage over 200k, no statusline/env -> inferred 1M window, latched for the session', () => {
  const h = makeHome();
  try {
    const p1 = h.writeTranscript([]);
    require('fs').writeFileSync(p1, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 210000,
    }) + '\n', 'utf8');

    const r1 = getContextPct(p1, {}, { home: h.home, sessionId: 'sess-big' });
    assert.ok(r1);
    assert.strictEqual(r1.windowLabel, 'inferred-1m');
    assert.strictEqual(r1.windowKnown, true);
    assert.strictEqual(r1.max, 1000000);

    // LATCHED: a LATER call whose usage happens to read back under 200k must
    // still use the inferred 1M window (a fresh transcript segment / a
    // momentary dip must not un-infer it for the rest of the session).
    const p2 = h.writeTranscript([]);
    require('fs').writeFileSync(p2, assistantUsageLine({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 50000,
    }) + '\n', 'utf8');
    const r2 = getContextPct(p2, {}, { home: h.home, sessionId: 'sess-big' });
    assert.strictEqual(r2.windowLabel, 'inferred-1m');
    assert.strictEqual(r2.max, 1000000);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: Codex rollout format (event_msg/token_count) is a REAL reading, not an estimate', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    const codexLine = JSON.stringify({
      timestamp: '2026-06-25T02:46:34.572Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, total_tokens: 43928 },
          model_context_window: 258400,
        },
      },
    });
    require('fs').writeFileSync(p, codexLine + '\n', 'utf8');

    const r = getContextPct(p, {}, { home: h.home, sessionId: 'codex-sess' });
    assert.ok(r);
    assert.strictEqual(r.source, 'codex-transcript');
    assert.strictEqual(r.estimated, false);
    assert.strictEqual(r.windowKnown, true);
    assert.strictEqual(r.max, 258400);
    assert.strictEqual(r.used, 43928);
    assert.ok(Math.abs(r.pct - (43928 / 258400) * 100) < 0.001);
  } finally {
    h.cleanup();
  }
});

test('getContextPct: Codex format takes priority over a Claude-shaped usage line when both somehow appear in the tail', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([]);
    const codexLine = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10000 }, model_context_window: 500000 } },
    });
    const claudeLine = assistantUsageLine({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 90000 });
    require('fs').writeFileSync(p, codexLine + '\n' + claudeLine + '\n', 'utf8');

    const r = getContextPct(p, {}, { home: h.home, sessionId: 'mixed-sess' });
    assert.strictEqual(r.source, 'codex-transcript');
    assert.strictEqual(r.max, 500000);
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
