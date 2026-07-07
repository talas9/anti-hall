'use strict';
// graphify-reminder (Stop hook). Surfaces a ONE-TIME nudge as a soft block
// (decision:'block') — the only Stop output channel that reaches the model (see
// the hook header). Gating: fires only when a graphify graph exists for the
// project AND >= 2 Edit/Write/MultiEdit/NotebookEdit tool_use entries are in the
// transcript. No-op (exit 0, no block) when: no graph, <2 edits, or already
// nudged this session (state file ~/.anti-hall/graphify-reminder-<session>).
//
// Graph presence is faked via a temp PROJECT dir used as the payload cwd that
// contains a graphify-out/ directory. The temp dir is created under os.tmpdir()
// (not a git repo) so gitToplevel() returns null and the only graph root checked
// is our controlled cwd — neither this repo nor the real machine is touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'graphify-reminder.js';

// The exact reminder text the hook emits as the block reason (quoted from
// plugins/anti-hall/hooks/graphify-reminder.js). Kept as the load-bearing
// stable substrings so light rewording of the surrounding prose still matches.
const REASON_MARKERS = [
  'graphify: significant edits this session and a knowledge graph is present',
  'graphify update .',
  'one-time reminder; stop again to dismiss',
];

// makeProject({ graph }) -> { dir, cleanup }. A disposable temp dir used as the
// hook's cwd. When graph:true a graphify-out/ subdir is created so hasGraph() is
// true; otherwise the dir is empty so the hook sees no graph.
function makeProject({ graph }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-proj-'));
  if (graph) fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
  return { dir, cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

// An assistant message carrying one Edit tool_use (an edit signal the hook
// counts). countEdits() walks message.content[] for tool_use blocks by name.
function editMessage(name) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, id: 'toolu_e', input: { file_path: '/x' } }],
    },
  };
}

function stopPayload(transcriptPath, cwd, sessionId) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, cwd, session_id: sessionId };
}

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

test('BLOCK: graph exists + significant edits (>=2) + first Stop -> one-time reminder block', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    const tp = h.writeTranscript([editMessage('Edit'), editMessage('Write')]);
    const r = testHook(HOOK, stopPayload(tp, proj.dir, 'sess-block'), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
    // Quote the reason from source: every load-bearing marker must be present.
    for (const m of REASON_MARKERS) {
      assert.ok(r.json.reason.includes(m), `reason missing marker: ${JSON.stringify(m)}; reason=${r.json.reason}`);
    }
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('NO-OP: graph absent -> exit 0, no block (nothing to remind about)', () => {
  const h = makeHome();
  const proj = makeProject({ graph: false });
  try {
    const tp = h.writeTranscript([editMessage('Edit'), editMessage('Write')]);
    const r = testHook(HOOK, stopPayload(tp, proj.dir, 'sess-nograph'), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(!isBlock(r), `expected no block; stdout: ${r.stdout}`);
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('NO-OP: no edits (<2) -> stay quiet even with a graph present', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    // Only ONE edit -> below the editCount < 2 threshold -> no nudge.
    const tp = h.writeTranscript([editMessage('Edit')]);
    const r = testHook(HOOK, stopPayload(tp, proj.dir, 'sess-noedit'), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(!isBlock(r), `expected no block (1 edit < 2); stdout: ${r.stdout}`);
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('NO REPEAT: already nudged this session -> second Stop stays quiet (single non-looping reminder)', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    const tp = h.writeTranscript([editMessage('Edit'), editMessage('MultiEdit')]);
    // First Stop nudges (writes ~/.anti-hall/graphify-reminder-<session>).
    const first = testHook(HOOK, stopPayload(tp, proj.dir, 'sess-repeat'), { home: h.home });
    assert.ok(isBlock(first), `first Stop should block; stdout: ${first.stdout}`);
    // Second Stop, SAME session id -> state file present -> no repeat block.
    const second = testHook(HOOK, stopPayload(tp, proj.dir, 'sess-repeat'), { home: h.home });
    assert.strictEqual(second.status, 0, 'second must exit 0');
    assert.ok(!isBlock(second), `expected no repeat block; stdout: ${second.stdout}`);
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});
