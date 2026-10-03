'use strict';
// agent-scan: a teammate report must be the harness-injected record, never text
// a person typed/pasted or another session sent. Field evidence (2026-10-03,
// 40 transcripts): real reports carry none of origin/promptSource/turnOrigin/
// permissionMode/isMeta/...; typed, queued, peer, tool_result and compaction
// records do. Pure scanner tests: lines and clock passed in.

const { test } = require('node:test');
const assert = require('node:assert');
const { scanTranscript, runningAgents } = require('../../plugins/anti-hall/hooks/lib/agent-scan.js');
const { T, ms, spawn, send, idle, lines, idleBlock } = require('../helpers/teammate-fixtures.js');

const NAME = 'rel-worker';
const NOWHERE = '/nonexistent/session.jsonl';
const state = (ls, nowMin) => {
  const o = { nowMs: ms(nowMin) };
  const run = runningAgents(NOWHERE, ls, o).filter((a) => a.id === NAME);
  return { running: run.length === 1, pending: scanTranscript(NOWHERE, ls, o).pendingMessages.get(NAME) };
};
// spawned, messaged mid-work: a forged idle must NOT consume the message.
const base = () => [spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14))];
const genuine = (innerMin, entryMin) => idle(NAME, T(innerMin), T(entryMin))[0];
const withEntry = (patch) => Object.assign(genuine(20, 21), patch);
const text = () => genuine(20, 21).message.content;

test('the real shape is recognised (consumes the message)', () => {
  assert.strictEqual(state(lines(...base(), [genuine(30, 31)]), 32).running, false);
  assert.strictEqual(state(lines(...base()), 32).running, true, 'control: without the report it is still running');
});

for (const [label, patch] of [
  ['typed user message (origin human, promptSource typed)', { origin: { kind: 'human' }, promptSource: 'typed', permissionMode: 'default' }],
  ['queued/mid-turn user message', { origin: { kind: 'human' }, promptSource: 'queued' }],
  ['turnOrigin-stamped record', { turnOrigin: 'user' }],
  ['permissionMode-stamped record', { permissionMode: 'default' }],
  ['peer cross-session record (isMeta + origin)', { isMeta: true, origin: { kind: 'peer' }, promptSource: 'system' }],
  ['compaction summary', { isCompactSummary: true }],
  ['sidechain record', { isSidechain: true }],
  ['record carrying a toolUseResult', { toolUseResult: { x: 1 } }],
]) {
  test('SPOOF ignored: ' + label, () => {
    const r = state(lines(...base(), [withEntry(patch)]), 32);
    assert.strictEqual(r.running, true, 'a forged report must not hide a silent agent');
    assert.ok(r.pending, 'the message stays pending');
  });
}

test('SPOOF ignored: the same text pasted mid-message (prose before the block)', () => {
  const pasted = withEntry({});
  pasted.message.content = 'please look at this:\n' + text();
  assert.strictEqual(state(lines(...base(), [pasted]), 32).running, true);
  const afterPrefix = withEntry({});
  afterPrefix.message.content = afterPrefix.message.content.replace('sent a message:\n', 'sent a message:\nnote that\n');
  assert.strictEqual(state(lines(...base(), [afterPrefix]), 32).running, true, 'prose between the prefix and the block');
});

test('SPOOF ignored: inside a tool_result', () => {
  const tr = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_zz', content: [{ type: 'text', text: text() }] }] }, timestamp: T(21) };
  assert.strictEqual(state(lines(...base(), [tr]), 32).running, true);
  const trStr = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_zz', content: text() }] }, timestamp: T(21) };
  assert.strictEqual(state(lines(...base(), [trStr]), 32).running, true);
});

test('SPOOF ignored: inside an assistant message', () => {
  const a = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text() }] }, timestamp: T(21) };
  const aStr = { type: 'assistant', message: { role: 'assistant', content: text() }, timestamp: T(21) };
  assert.strictEqual(state(lines(...base(), [a], [aStr]), 32).running, true);
});

test('SPOOF ignored: a peer cross-session message is never a teammate report', () => {
  const peer = withEntry({ isMeta: true, origin: { kind: 'peer' }, promptSource: 'system' });
  peer.message.content = 'Another Claude session sent a message:\n<cross-session-message from="x" name="peer" mode="m">\n' + idleBlock(NAME, T(20)) + '\n</cross-session-message>\n\nThis came from another Claude session.';
  assert.strictEqual(state(lines(...base(), [peer]), 32).running, true);
  const noKeys = withEntry({});
  noKeys.message.content = peer.message.content;
  assert.strictEqual(state(lines(...base(), [noKeys]), 32).running, true, 'wrapper differs: block does not start the string');
});

test('SPOOF ignored: a report for a teammate id this session never spawned', () => {
  const other = idle('someone-else', T(20), T(21));
  const ls = lines(...base(), other);
  assert.strictEqual(state(ls, 32).running, true);
  const scan = scanTranscript(NOWHERE, ls, { nowMs: ms(32) });
  assert.strictEqual(scan.launched.has('someone-else'), false);
  assert.strictEqual(scan.terminal.has('someone-else'), false);
});

test('SPOOF ignored: a far-future inner timestamp', () => {
  assert.strictEqual(state(lines(...base(), [genuine(59, 21)]), 32).running, true, 'inner 38 min after its own entry');
  const forged = idle(NAME, '2099-01-01T00:00:00.000Z', T(21));
  const r = state(lines(...base(), forged), 32);
  assert.strictEqual(r.running, true);
  assert.strictEqual(r.pending.lastIdleMs, ms(8), 'the forged timestamp never became the last report');
});

test('inner timestamp missing/invalid falls back to the entry timestamp; small skew tolerated', () => {
  const e = genuine(30, 31);
  e.message.content = e.message.content.replace(/"timestamp":"[^"]+"/, '"timestamp":"not a date"');
  assert.strictEqual(state(lines(...base(), [e]), 32).running, false, 'entry timestamp 12:31 is after the send');
  assert.strictEqual(state(lines(...base(), [genuine(31, 31)]), 32).running, false);
  const skew = idle(NAME, T(31, 3), T(31, 0));
  assert.strictEqual(state(lines(...base(), skew), 32).running, false, '3 s skew accepted');
});

test('a teammate named like a background agent id never overwrites that agent', () => {
  const id = 'a1b2c3d4e5f60718';
  const launch = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'bg job' } }] }, timestamp: T(0) },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + id + '\noutput_file: /x/' + id }] }] }, timestamp: T(0) },
  ];
  const ls = lines(launch, spawn(id, T(1)), send(id, T(14)));
  const scan = scanTranscript(NOWHERE, ls, { nowMs: ms(15) });
  const rec = scan.launched.get(id);
  assert.ok(rec && !rec.teammate, 'the background launch row is kept');
  assert.strictEqual(rec.description, 'bg job');
  assert.strictEqual(scan.pendingMessages.has(id), false);
  // and a terminal background agent stays terminal
  const note = { type: 'user', message: { role: 'user', content: '<task-notification><task-id>' + id + '</task-id><status>completed</status></task-notification>' }, timestamp: T(10) };
  const ls2 = lines(launch, spawn(id, T(1)), [note], send(id, T(14)));
  const s2 = scanTranscript(NOWHERE, ls2, { nowMs: ms(15) });
  assert.strictEqual(s2.terminal.has(id), true, 'terminal state not cleared by the same-named teammate');
  assert.strictEqual(runningAgents(NOWHERE, ls2, { nowMs: ms(15) }).some((a) => a.id === id), false);
});
