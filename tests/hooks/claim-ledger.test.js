'use strict';
// claim-ledger (Stop hook, LEDGER-ONLY). Never blocks, never prints, exit 0
// always. Records would-be flags to ~/.anti-hall/claim-ledger/<session>.jsonl.
//
// Session id 't' -> ~/.anti-hall/claim-ledger/t.jsonl (+ t.last hash marker).
// The hook reads the LAST assistant text as the message under test and
// everything before it in the transcript as cumulative evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'claim-ledger.js';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

function userPrompt(text) {
  return { type: 'user', message: { role: 'user', content: text } };
}

function toolUse(name, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
  };
}

function toolResult(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
  };
}

function readLedger(h) {
  const p = path.join(h.antiHall, 'claim-ledger', 't.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function silentAllow(r) {
  return r.status === 0 && r.stdout.trim() === '';
}

test('HARD: "task N of" absent from evidence is recorded, never blocks', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('status?'),
      toolUse('Bash', { command: 'git status' }),
      toolResult('On branch main\nnothing to commit'),
      assistantMessage('You are on task 3 of your queue.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r), `expected silent exit 0; stdout: ${r.stdout}`);
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].tools_this_turn, 1);
    assert.deepStrictEqual(
      recs[0].flags.map((f) => [f.cls, f.kind, f.token]),
      [['hard', 'task', 'task 3 of']]
    );
  } finally {
    h.cleanup();
  }
});

test('HARD: a count NOT in evidence is recorded; a rounded count IS in evidence (value match)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('time it'),
      toolUse('Bash', { command: 'time claude -p' }),
      toolResult('14.40s user 22.57s system 128% cpu 28.706 total\n10.32s user 41.33s system 148% cpu 34.887 total'),
      assistantMessage('Measured 28.7 s and 34.9 s; I would estimate ~37 s per turn.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(
      recs[0].flags.map((f) => [f.cls, f.kind, f.token]),
      [['hard', 'count', '37 s']]
    );
  } finally {
    h.cleanup();
  }
});

test('HARD: thousands separators are normalized on both sides', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('count'),
      toolUse('Bash', { command: 'wc -l' }),
      toolResult('1326 messages'),
      assistantMessage('That is 1,326 messages and 12 files.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => f.token), ['12 files']);
  } finally {
    h.cleanup();
  }
});

test('HARD: SHA absent from evidence is recorded; SHA present is not', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('which commit'),
      toolUse('Bash', { command: 'git log -1' }),
      toolResult('d941e62 release: v0.99.2'),
      assistantMessage('Released as d941e62; the fix landed in 7f253cd earlier.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => [f.kind, f.token]), [['sha', '7f253cd']]);
  } finally {
    h.cleanup();
  }
});

test('SOFT: state word with ZERO tool calls this turn is recorded as soft; with a tool call it is not', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('is it done?'),
      assistantMessage('The V2-4 workspace spawn is still running.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].tools_this_turn, 0);
    assert.deepStrictEqual(recs[0].flags.map((f) => [f.cls, f.kind]), [['soft', 'state-no-tool']]);
  } finally {
    h.cleanup();
  }

  const h2 = makeHome();
  try {
    const tp = h2.writeTranscript([
      userPrompt('is it done?'),
      toolUse('Bash', { command: 'devswarm roster' }),
      toolResult('V2-4 live'),
      assistantMessage('The V2-4 workspace spawn is still running.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h2.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h2), []);
  } finally {
    h2.cleanup();
  }
});

test('SOFT: "N days ago" is always recorded as soft (date arithmetic is unverifiable)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('how old'),
      toolUse('Bash', { command: 'cat ts' }),
      toolResult('ts: 2026-08-04T00:00:00Z'),
      assistantMessage('Those rows are from eight days ago; the newest is 8 days ago.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => [f.cls, f.kind, f.token]), [['soft', 'days-ago', '8 days ago']]);
  } finally {
    h.cleanup();
  }
});

test('EVIDENCE is cumulative across turns, includes tool inputs, hook attachments and prompts', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('run it'),
      toolUse('Bash', { command: 'sleep 5 seconds' }),
      toolResult('done'),
      assistantMessage('Ran it.'),
      { type: 'attachment', attachment: { type: 'hook_success', stdout: 'roster: 29 workspaces' } },
      userPrompt('we have 7 hooks, right?'),
      assistantMessage('Yes: 7 hooks, 29 workspaces, and the run took 5 seconds.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h), []);
    // The .last marker still records the examined message hash.
    assert.ok(fs.existsSync(path.join(h.antiHall, 'claim-ledger', 't.last')));
  } finally {
    h.cleanup();
  }
});

test('The message under test does not vouch for itself; an EARLIER assistant message does', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('a'),
      assistantMessage('There are 4 files.'),
      userPrompt('b'),
      toolUse('Bash', { command: 'ls' }),
      toolResult('x'),
      assistantMessage('Still 4 files, and now 9 rows.'),
    ]);
    testHook(HOOK, stopPayload(tp), { home: h.home });
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => f.token), ['9 rows']);
  } finally {
    h.cleanup();
  }
});

test('DEDUP: the same message is recorded once across repeated Stop events; a new message is recorded again', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('a'),
      toolUse('Bash', { command: 'x' }),
      toolResult('y'),
      assistantMessage('task 3 of 9 is next.'),
    ]);
    testHook(HOOK, stopPayload(tp), { home: h.home });
    testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.strictEqual(readLedger(h).length, 1);
    fs.appendFileSync(tp, JSON.stringify(assistantMessage('Actually task 4 of 9 is next.')) + '\n');
    testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.strictEqual(readLedger(h).length, 2);
  } finally {
    h.cleanup();
  }
});

test('SKIP: ~/.anti-hall/skip.json {"claim-ledger": future} suppresses recording', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'claim-ledger': Date.now() + 60_000 });
    const tp = h.writeTranscript([userPrompt('a'), assistantMessage('task 3 of 9, still running.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    assert.ok(!fs.existsSync(path.join(h.antiHall, 'claim-ledger')));
  } finally {
    h.cleanup();
  }
});

test('WINDOW: a transcript larger than the 2 MB tail cap is read from the tail only, still exit 0', () => {
  const h = makeHome();
  try {
    const filler = { type: 'user', message: { role: 'user', content: 'x'.repeat(4096) } };
    const lines = [];
    for (let i = 0; i < 600; i++) lines.push(filler); // ~2.5 MB
    lines.push(userPrompt('late'), assistantMessage('task 3 of 9.'));
    const tp = h.writeTranscript(lines);
    assert.ok(fs.statSync(tp).size > 2 * 1024 * 1024);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].window_truncated, true);
    assert.deepStrictEqual(recs[0].flags.map((f) => f.token), ['task 3 of']);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin, malformed JSON, missing transcript, no transcript_path, malformed lines', () => {
  const h = makeHome();
  try {
    for (const raw of ['', '{bad', 'null', '[]']) {
      const r = testHookRaw(HOOK, raw, { home: h.home });
      assert.ok(silentAllow(r), `raw=${JSON.stringify(raw)} stdout=${r.stdout} stderr=${r.stderr}`);
    }
    let r = testHook(HOOK, { hook_event_name: 'Stop', session_id: 't' }, { home: h.home });
    assert.ok(silentAllow(r));
    r = testHook(HOOK, stopPayload(path.join(h.home, 'missing.jsonl')), { home: h.home });
    assert.ok(silentAllow(r));
    const tp = path.join(h.home, 'garbage.jsonl');
    fs.writeFileSync(tp, '{not json\n\n' + JSON.stringify({ type: 'assistant', message: { content: 'x' } }) + '\n{"type":"user"}\n', 'utf8');
    r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h), []);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: unwritable ledger dir still exits 0 silently', () => {
  const h = makeHome();
  try {
    // Occupy the ledger path with a FILE so mkdirSync(recursive) fails.
    fs.writeFileSync(path.join(h.antiHall, 'claim-ledger'), 'not a dir', 'utf8');
    const tp = h.writeTranscript([userPrompt('a'), assistantMessage('task 3 of 9.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r), `stdout=${r.stdout} stderr=${r.stderr}`);
  } finally {
    h.cleanup();
  }
});

test('unit: numberInEvidence matches by value at the claim precision', () => {
  const { numberInEvidence, collectNumbers } = require('../../plugins/anti-hall/hooks/claim-ledger.js');
  const ev = 'cpu 34.887 total; 28.706 total; 1326 messages; 0.3421s';
  const nums = collectNumbers(ev);
  assert.strictEqual(numberInEvidence('34.9', ev, nums), true);
  assert.strictEqual(numberInEvidence('35', ev, nums), true); // 34.887 rounds to 35 at 0 decimals
  assert.strictEqual(numberInEvidence('34', ev, nums), false);
  assert.strictEqual(numberInEvidence('28.71', ev, nums), true);
  assert.strictEqual(numberInEvidence('28.72', ev, nums), false);
  assert.strictEqual(numberInEvidence('1,326', ev, nums), true);
  assert.strictEqual(numberInEvidence('0.3', ev, nums), true);
  assert.strictEqual(numberInEvidence('37', ev, nums), false);
});
