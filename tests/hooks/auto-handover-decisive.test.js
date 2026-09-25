'use strict';
// autoHandover.decisivePrompt (v0.109.5) — the Stop-time (Stop / pause-nag
// path) directive that tells the agent to END its reply with one prominent,
// decisive line naming the exact /compact (or /clear, or Codex /new)
// command, once this session's handover exists and is fresh; a STALE
// handover (work continued after it was written) gets a "refresh first"
// line instead. hooks/auto-handover-pause-nag.js + hooks/lib/auto-handover-text.js
// (buildDecisiveSuffix) + hooks/lib/handover-freshness.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
const { sessionTag, writeLatch } = require('../../plugins/anti-hall/hooks/lib/auto-handover-state.js');
const freshness = require('../../plugins/anti-hall/hooks/lib/handover-freshness.js');

const HOOK = 'auto-handover-pause-nag.js';
const SID = 'dec-s1';
const KNOWN_WINDOW = { ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' };

function assistantUsageLine(usedTokens, extra) {
  return JSON.stringify(Object.assign({
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: usedTokens },
    },
  }, extra || {}));
}

function editToolLine(filePath, tsOffsetMs) {
  return JSON.stringify({
    type: 'assistant', isSidechain: false,
    timestamp: new Date(Date.now() + (tsOffsetMs || 0)).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: filePath } }] },
  });
}

function pctToTokens(pct) { return Math.round((pct / 100) * 200000); }

function localDate() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

// writeHandover(cwd, body, mtimeOffsetMs) — the file the handover skill
// writes, under this session's own dir (mirrors auto-handover-gate.test.js).
function writeHandover(cwd, body, mtimeOffsetMs) {
  const dir = path.join(cwd, '.anti-hall', 'handovers', localDate(), SID);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'HANDOVER.md');
  fs.writeFileSync(p, body || '# handover\n', 'utf8');
  const t = (Date.now() + (mtimeOffsetMs != null ? mtimeOffsetMs : -5000)) / 1000; // default: written 5s ago
  fs.utimesSync(p, t, t);
  return p;
}

function setup() {
  const h = makeHome();
  const cwd = path.join(h.home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  return { h, cwd };
}

function firedLatch(extra) {
  return Object.assign({ fired: true, firedAt: Date.now() - 60000, firedPct: 85, lastNagPct: 85, lastNagAt: Date.now() - 16 * 60 * 1000 }, extra);
}

function decision(r) {
  return r.json && r.json.decision === 'block' ? r.json.reason : null;
}

const OPEN_ITEMS = '## Open items\n1. finish the thing\n\n';
const DONE_OPEN_ITEMS = '## Open items\nnone\n\n';
const NEXT_ACTION_OPEN = '## Next action\nkeep going on the feature\n\n';
const NEXT_ACTION_DONE = '## Next action\nnone — task is finished\n\n';

test('decisive: fresh handover at Stop pause-nag -> the directive contains the good-point line and /compact', () => {
  const s = setup();
  try {
    const tag = sessionTag({ session_id: SID });
    writeLatch(s.h.home, tag, firedLatch());
    writeHandover(s.cwd, '# Handover\n\n' + NEXT_ACTION_OPEN + OPEN_ITEMS, -5000);
    const tp = s.h.writeTranscript([]);
    fs.writeFileSync(tp, assistantUsageLine(pctToTokens(90)) + '\n', 'utf8');
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: SID, cwd: s.cwd, transcript_path: tp }, { home: s.h.home, env: KNOWN_WINDOW, expectJson: true });
    const reason = decision(r);
    assert.ok(reason, 'expected a nag');
    assert.match(reason, /🟢 \*\*GOOD POINT TO \/compact NOW\*\*/);
    assert.match(reason, /handover saved at/);
    assert.doesNotMatch(reason, /Refresh the handover first/);
  } finally { s.h.cleanup(); }
});

test('decisive: stale handover (work continued after it was written) -> refresh-first line, never "good point"', () => {
  const s = setup();
  try {
    const tag = sessionTag({ session_id: SID });
    writeLatch(s.h.home, tag, firedLatch());
    const handoverPath = writeHandover(s.cwd, '# Handover\n\n' + NEXT_ACTION_OPEN + OPEN_ITEMS, -60000); // written 60s ago
    const tp = s.h.writeTranscript([]);
    const lines = [
      assistantUsageLine(pctToTokens(90)),
      editToolLine(path.join(s.cwd, 'src', 'file.js'), 0), // a mutation AFTER the handover mtime
    ];
    fs.writeFileSync(tp, lines.join('\n') + '\n', 'utf8');
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: SID, cwd: s.cwd, transcript_path: tp }, { home: s.h.home, env: KNOWN_WINDOW, expectJson: true });
    const reason = decision(r);
    assert.ok(reason, 'expected a nag');
    assert.match(reason, /⚠️ \*\*Refresh the handover first\*\*, then \/compact/);
    assert.doesNotMatch(reason, /GOOD POINT/);
    void handoverPath;
  } finally { s.h.cleanup(); }
});

test('decisive: handover reads as done (empty Open items) -> recommends /clear instead of /compact', () => {
  const s = setup();
  try {
    const tag = sessionTag({ session_id: SID });
    writeLatch(s.h.home, tag, firedLatch());
    writeHandover(s.cwd, '# Handover\n\n' + NEXT_ACTION_DONE + DONE_OPEN_ITEMS, -5000);
    const tp = s.h.writeTranscript([]);
    fs.writeFileSync(tp, assistantUsageLine(pctToTokens(90)) + '\n', 'utf8');
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: SID, cwd: s.cwd, transcript_path: tp }, { home: s.h.home, env: KNOWN_WINDOW, expectJson: true });
    const reason = decision(r);
    assert.match(reason, /🟢 \*\*GOOD POINT TO \/clear NOW\*\*/);
  } finally { s.h.cleanup(); }
});

test('decisive: Codex session (turn_id) recommends /new instead of /clear', () => {
  const s = setup();
  try {
    const tag = sessionTag({ session_id: SID });
    writeLatch(s.h.home, tag, firedLatch());
    writeHandover(s.cwd, '# Handover\n\n' + NEXT_ACTION_OPEN + OPEN_ITEMS, -5000);
    const tp = s.h.writeTranscript([]);
    fs.writeFileSync(tp, assistantUsageLine(pctToTokens(90)) + '\n', 'utf8');
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: SID, cwd: s.cwd, transcript_path: tp, turn_id: 't1' }, { home: s.h.home, env: KNOWN_WINDOW, expectJson: true });
    const reason = decision(r);
    assert.match(reason, /🟢 \*\*GOOD POINT TO \/compact NOW\*\*/);
    assert.match(reason, /\/new if the next task is different/);
    assert.doesNotMatch(reason, /\/clear if the next task is different/);
  } finally { s.h.cleanup(); }
});

test('decisive: autoHandover.decisivePrompt=false -> old plain pause-nag text, no glyph line', () => {
  const s = setup();
  try {
    settings.set('autoHandover', 'decisivePrompt', false, { home: s.h.home });
    const tag = sessionTag({ session_id: SID });
    writeLatch(s.h.home, tag, firedLatch());
    writeHandover(s.cwd, '# Handover\n\n' + NEXT_ACTION_OPEN + OPEN_ITEMS, -5000);
    const tp = s.h.writeTranscript([]);
    fs.writeFileSync(tp, assistantUsageLine(pctToTokens(90)) + '\n', 'utf8');
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: SID, cwd: s.cwd, transcript_path: tp }, { home: s.h.home, env: KNOWN_WINDOW, expectJson: true });
    const reason = decision(r);
    assert.ok(reason, 'expected the plain nag');
    assert.doesNotMatch(reason, /GOOD POINT/);
    assert.doesNotMatch(reason, /Refresh the handover first/);
    assert.match(reason, /Good stopping point/);
  } finally { s.h.cleanup(); }
});

test('decisive: no handover file yet -> no decisive line at all (fire directive stays plain)', () => {
  const s = setup();
  try {
    const tp = s.h.writeTranscript([]);
    fs.writeFileSync(tp, assistantUsageLine(pctToTokens(90)) + '\n', 'utf8');
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: SID, cwd: s.cwd, transcript_path: tp }, { home: s.h.home, env: KNOWN_WINDOW, expectJson: true });
    const reason = decision(r);
    assert.match(reason, /AUTO-HANDOVER REQUIRED/);
    assert.doesNotMatch(reason, /GOOD POINT/);
    assert.doesNotMatch(reason, /Refresh the handover first/);
  } finally { s.h.cleanup(); }
});

test('decisive: respects the existing nag caps (nagQuietMin) -- no extra spam beyond the normal cadence', () => {
  const s = setup();
  try {
    const tag = sessionTag({ session_id: SID });
    // Last nag 1s ago, risen only 1 point (< nagStepPct 5) -> normal cap says silent.
    writeLatch(s.h.home, tag, firedLatch({ lastNagAt: Date.now() - 1000, lastNagPct: 89 }));
    writeHandover(s.cwd, '# Handover\n\n' + NEXT_ACTION_OPEN + OPEN_ITEMS, -5000);
    const tp = s.h.writeTranscript([]);
    fs.writeFileSync(tp, assistantUsageLine(pctToTokens(90)) + '\n', 'utf8');
    const r = testHook(HOOK, { hook_event_name: 'Stop', session_id: SID, cwd: s.cwd, transcript_path: tp }, { home: s.h.home, env: KNOWN_WINDOW, expectJson: true });
    assert.strictEqual(decision(r), null, 'the decisive line must not bypass the existing nagQuietMin/nagStepPct cap');
  } finally { s.h.cleanup(); }
});

// --- hooks/lib/handover-freshness.js unit coverage ---

test('handover-freshness.isFresh: no counted work -> null (unprovable, never claim stale)', () => {
  assert.strictEqual(freshness.isFresh([], Date.now()), null);
  assert.strictEqual(freshness.isFresh(null, Date.now()), null);
});

test('handover-freshness.isFresh: mutation timestamp after handover mtime -> false (stale)', () => {
  const mtime = Date.now() - 60000;
  const lines = [editToolLine('/x.js', 0)];
  assert.strictEqual(freshness.isFresh(lines, mtime), false);
});

test('handover-freshness.isFresh: mutation timestamp before handover mtime -> true (fresh)', () => {
  const mtime = Date.now();
  const lines = [editToolLine('/x.js', -60000)];
  assert.strictEqual(freshness.isFresh(lines, mtime), true);
});

test('handover-freshness.isTaskComplete: empty Open items -> true', () => {
  assert.strictEqual(freshness.isTaskComplete('# H\n\n' + NEXT_ACTION_OPEN + DONE_OPEN_ITEMS), true);
});

test('handover-freshness.isTaskComplete: open Open items + open Next action -> false', () => {
  assert.strictEqual(freshness.isTaskComplete('# H\n\n' + NEXT_ACTION_OPEN + OPEN_ITEMS), false);
});

test('handover-freshness.isTaskComplete: "done" Next action -> true', () => {
  assert.strictEqual(freshness.isTaskComplete('# H\n\n' + NEXT_ACTION_DONE + OPEN_ITEMS), true);
});

// --- settings default ---

test('resolveEffective(): decisivePrompt defaults to true', () => {
  const { resolveEffective } = require('../../plugins/anti-hall/hooks/lib/auto-handover-config.js');
  const h = makeHome();
  try {
    const r = resolveEffective({ home: h.home, env: {} });
    assert.strictEqual(r.decisivePrompt, true);
  } finally { h.cleanup(); }
});
