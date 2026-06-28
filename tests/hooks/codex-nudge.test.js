'use strict';
// codex-nudge (Stop hook, advisory). Nudges ONCE when a session shipped >= MIN
// substantial code-file edits with no Codex review. Block => stdout {decision:'block'}
// + exit 0. Mirrors the speculation-guard test harness; adds tool_use transcript lines.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'codex-nudge.js';
const STATE_FILE = 'codex-nudge-state-t.json';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}
function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}
// Build an assistant transcript line carrying tool_use blocks.
function toolUseMessage(tools) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: tools.map((t, i) => ({
        type: 'tool_use', name: t.name, id: 'tu' + i, input: t.input,
      })),
    },
  };
}
const edit = (file_path) => ({ name: 'Edit', input: { file_path } });
const codexSpawn = () => ({ name: 'Agent', input: { subagent_type: 'codex:codex-rescue', description: 'review' } });
// Workflow agent() uses `agentType` (not subagent_type) — must also count as a review.
const codexSpawnWorkflow = () => ({ name: 'Agent', input: { agentType: 'codex:codex-rescue', label: 'critic' } });

test('NUDGE: 3 code edits, no Codex review -> block', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts')]),
      toolUseMessage([edit('/x/c.py')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected nudge; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /codex/i);
  } finally { h.cleanup(); }
});

test('ALLOW: below threshold (only 2 code edits)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts')])]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (below MIN); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ALLOW: 3 code edits but a Codex review already happened', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
      toolUseMessage([codexSpawn()]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (codex consulted); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ALLOW: Codex review via Workflow `agentType` field (not subagent_type)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
      toolUseMessage([codexSpawnWorkflow()]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (codex via agentType); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('NUDGE: .vue/.svelte frontend files count as substantial code', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/A.vue'), edit('/x/B.svelte'), edit('/x/c.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected nudge (.vue/.svelte are code); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ALLOW: 3 doc/.md edits are NOT substantial code', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.md'), edit('/x/b.json'), edit('/x/c.txt')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (docs only); stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('DEDUPE: same code-file set already nudged -> allow', () => {
  const h = makeHome();
  try {
    // Pre-seed state with the signature for {a.ts,b.ts,c.ts} would require the hook's
    // hash; instead assert idempotency by running twice and checking the 2nd allows
    // only when the file set is unchanged. First run nudges, second (same set) quiet.
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
    ]);
    const r1 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r1), `first run should nudge; stdout: ${r1.stdout}`);
    const r2 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r2), `second run (same files) should be quiet; stdout: ${r2.stdout}`);
  } finally { h.cleanup(); }
});

test('CAP: nudges>=2 already -> allow even with a new file set', () => {
  const h = makeHome();
  try {
    h.writeState(STATE_FILE, { sig: 'oldsig', nudges: 2 });
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/p.ts'), edit('/x/q.ts'), edit('/x/r.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `cap reached; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ENV off-switch: ANTIHALL_CODEX_NUDGE=off -> allow', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTIHALL_CODEX_NUDGE: 'off' } });
    assert.ok(!isBlock(r), `off-switch; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ESCAPE HATCH: skip.json {codex-nudge: future} -> allow', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'codex-nudge': Date.now() + 600000 });
    const tp = h.writeTranscript([
      toolUseMessage([edit('/x/a.ts'), edit('/x/b.ts'), edit('/x/c.ts')]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `skip active; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: empty stdin -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});
