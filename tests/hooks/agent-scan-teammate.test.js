'use strict';
// agent-scan: a named in-process teammate that was sent a message is RUNNING
// (pendingMessage) until it reports on a turn that began after the message.
// The first idle_notification after a send does not prove that: it can be the
// earlier turn's report, written to the transcript late (field, 2026-10-02).
// Pure scanner tests: lines passed in, clock passed in, no HOME, no subprocess.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanTranscript, runningAgents, runningAgentsOrNull } = require('../../plugins/anti-hall/hooks/lib/agent-scan.js');
const { T, ms, spawn, send, idle, stop, lines, inboxResult, idleBlock, tid } = require('../helpers/teammate-fixtures.js');

const NAME = 'rel-worker';
const NOWHERE = '/nonexistent/session.jsonl';
const state = (ls, nowMin) => {
  const o = { nowMs: ms(nowMin) };
  const s = scanTranscript(NOWHERE, ls, o);
  const run = runningAgents(NOWHERE, ls, o).filter((a) => a.id === NAME);
  return { running: run.length === 1, row: run[0], pending: s.pendingMessages.get(NAME), terminal: s.terminal.has(NAME) };
};

test('spawned teammate with no message is not reported (unchanged)', () => {
  const r = state(lines(spawn(NAME, T(0))), 1);
  assert.strictEqual(r.running, false);
  assert.strictEqual(r.pending, undefined);
});

test('FIELD CASE: idle teammate, send, then its EARLIER report arrives late -> running', () => {
  const ls = lines(spawn(NAME, T(0)), send(NAME, T(14)), idle(NAME, T(8), T(15)));
  const r = state(ls, 16);
  assert.strictEqual(r.running, true, 'the report predates the send: it is not an answer to it');
  assert.strictEqual(r.row.pendingMessage, true);
  assert.strictEqual(r.pending.sentAtMs, ms(14));
  assert.strictEqual(r.pending.lastIdleMs, ms(8));
});

test('send to an idle teammate that wakes and finishes -> running, then not', () => {
  const head = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14)));
  assert.strictEqual(state(head, 15).running, true);
  const r = state(head.concat(lines(idle(NAME, T(30), T(31)))), 32);
  assert.strictEqual(r.running, false);
  assert.strictEqual(r.pending, undefined, 'a report of a turn begun after the send consumes it');
});

test('send to a BUSY teammate: first idle ends the old turn, second consumes the message', () => {
  const sent = lines(spawn(NAME, T(0)), send(NAME, T(1)));
  assert.strictEqual(state(sent, 2).running, true);
  const one = sent.concat(lines(idle(NAME, T(2), T(3))));
  assert.strictEqual(state(one, 4).running, true, 'first idle after the send is the pre-message turn');
  const two = one.concat(lines(idle(NAME, T(5), T(6))));
  assert.strictEqual(state(two, 7).running, false);
});

test('two idle blocks in ONE entry (real shape) are both counted', () => {
  const e = idle(NAME, T(2), T(6))[0];
  e.message.content = e.message.content.replace('\n\nThis came', '\n\n' + idleBlock(NAME, T(5)) + '\n\nThis came');
  const r = state(lines(spawn(NAME, T(0)), send(NAME, T(1)), [e]), 7);
  assert.strictEqual(r.running, false);
});

test('send to a teammate that never wakes: not running past the bound, fact still recorded', () => {
  const ls = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14)));
  assert.strictEqual(state(ls, 33).running, true, '19 min after the send: inside the bound');
  const r = state(ls, 34);
  assert.strictEqual(r.running, false, '20 min of no sign of life: no longer running');
  assert.strictEqual(r.pending.live, false);
  assert.strictEqual(r.pending.sentAtMs, ms(14));
});

test('TaskStop after the send -> terminal, nothing pending; an errored TaskStop stops nothing', () => {
  const head = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14)));
  const stopped = state(head.concat(lines(stop(NAME, T(15)))), 16);
  assert.strictEqual(stopped.running, false);
  assert.strictEqual(stopped.pending, undefined);
  assert.strictEqual(stopped.terminal, true);
  const byAgentId = state(head.concat(lines(stop(NAME + '@session-fx', T(15)))), 16);
  assert.strictEqual(byAgentId.pending, undefined);
  assert.strictEqual(state(head.concat(lines(stop(NAME, T(15), { error: true }))), 16).running, true);
});

test('ignoreUnansweredStops: the TaskStop being judged does not hide the pending message', () => {
  const ls = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14)), stop(NAME, T(15), { answered: false }));
  assert.strictEqual(scanTranscript(NOWHERE, ls, { nowMs: ms(16) }).pendingMessages.has(NAME), false);
  assert.strictEqual(scanTranscript(NOWHERE, ls, { nowMs: ms(16), ignoreUnansweredStops: true }).pendingMessages.has(NAME), true);
});

test('multiple sends: one sent mid-turn needs its own later report', () => {
  const head = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14)), send(NAME, T(15)));
  assert.strictEqual(state(head, 16).running, true);
  const one = head.concat(lines(idle(NAME, T(16), T(17))));
  const r1 = state(one, 18);
  assert.strictEqual(r1.running, true, 'the second message was queued behind the first turn');
  assert.strictEqual(r1.pending.sentAtMs, ms(15));
  assert.strictEqual(state(one.concat(lines(idle(NAME, T(19), T(20)))), 21).running, false);
});

test('spawn outside the window: its reports are not trusted -> unknown (never running, never terminal)', () => {
  const seenBefore = lines(idle(NAME, T(8), T(9)), send(NAME, T(14)));
  const r = state(seenBefore, 15);
  assert.strictEqual(r.running, false, 'no spawn record seen: the report proves nothing, the send alone is not a teammate');
  assert.strictEqual(r.pending, undefined);
  assert.strictEqual(r.terminal, false, 'unknown is never "finished"');
  assert.strictEqual(state(seenBefore.concat(lines(idle(NAME, T(16), T(17)))), 18).terminal, false);
});

test('a peer session name (never spawned, never reported) is not a teammate', () => {
  const r = state(lines(send(NAME, T(14))), 15);
  assert.strictEqual(r.running, false);
  assert.strictEqual(r.pending, undefined);
});

test('QUOTED TEXT is not a record', () => {
  const base = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)));
  const readId = tid();
  const quotes = [
    // a Bash/Read result that contains the inbox result text
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: readId, name: 'Read', input: { file_path: '/x' } }] }, timestamp: T(14) },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: readId, type: 'tool_result', content: [{ type: 'text', text: inboxResult(NAME) }] }] }, timestamp: T(14) },
    // typed / assistant text quoting it
    { type: 'user', message: { role: 'user', content: 'it said ' + inboxResult(NAME) }, timestamp: T(14) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: inboxResult(NAME) }] }, timestamp: T(14) },
  ].map((e) => JSON.stringify(e));
  assert.strictEqual(state(base.concat(quotes), 15).running, false, 'no genuine send -> nothing pending');

  // quoted idle blocks must not consume a genuine pending message
  const pend = base.concat(lines(send(NAME, T(14))));
  const idleQuotes = [
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: readId, type: 'tool_result', content: [{ type: 'text', text: 'Another Claude session sent a message:\n' + idleBlock(NAME, T(16)) }] }] }, timestamp: T(17) },
    { type: 'user', message: { role: 'user', content: 'look at this: ' + idleBlock(NAME, T(16)) }, timestamp: T(17) },
    { type: 'queue-operation', operation: 'enqueue', content: 'look at this: ' + idleBlock(NAME, T(16)), timestamp: T(17) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Another Claude session sent a message:\n' + idleBlock(NAME, T(16)) }] }, timestamp: T(17) },
  ].map((e) => JSON.stringify(e));
  assert.strictEqual(state(pend.concat(idleQuotes), 18).running, true);
  // a block whose `from` is another agent is not this teammate's report
  const other = idle('someone-else', T(16), T(17));
  other[0].message.content = other[0].message.content.replace(/teammate_id="someone-else"/g, 'teammate_id="' + NAME + '"');
  assert.strictEqual(state(pend.concat(lines(other)), 18).running, true);
});

test('missing timestamps -> unknown -> silent', () => {
  const ls = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14))).map((l) => { const e = JSON.parse(l); delete e.timestamp; return JSON.stringify(e); });
  const r = state(ls, 15);
  assert.strictEqual(r.running, false);
  assert.strictEqual(r.pending, undefined);
});

test('an inbox send result is not delivery evidence for a background agent it mentions', () => {
  const ID = 'cccc111122223333d';
  const launchId = tid();
  const sid = tid();
  const res = JSON.stringify({ success: true, message: 'Message sent to ' + NAME + "'s inbox", routing: { content: 'see agent ' + ID } });
  const ls = [
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: launchId, type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + ID + '\noutput_file: /tmp/x.output' }] }] }, timestamp: T(0) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: sid, name: 'SendMessage', input: { to: NAME, message: 'see agent ' + ID } }] }, timestamp: T(1) },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: sid, type: 'tool_result', content: [{ type: 'text', text: res }] }] }, timestamp: T(1) },
  ].map((e) => JSON.stringify(e));
  assert.strictEqual(scanTranscript(NOWHERE, ls, { nowMs: ms(2) }).terminal.has(ID), false);
});

test('sidechain transcript is the sign of life: a working teammate stays running past the bound', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-teammate-'));
  const tp = path.join(dir, 'sess.jsonl');
  const ls = lines(spawn(NAME, T(0)), idle(NAME, T(8), T(9)), send(NAME, T(14)));
  fs.writeFileSync(tp, ls.join('\n') + '\n');
  const sub = path.join(dir, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const side = path.join(sub, 'agent-a' + NAME + '-0123456789abcdef.jsonl');
  fs.writeFileSync(side, '{}\n');
  fs.utimesSync(side, ms(50) / 1000, ms(50) / 1000);
  // a different teammate whose name merely starts the same must not count
  const near = path.join(sub, 'agent-a' + NAME + '-two-0123456789abcdef.jsonl');
  fs.writeFileSync(near, '{}\n');
  fs.utimesSync(near, ms(200) / 1000, ms(200) / 1000);
  const at = (min) => runningAgentsOrNull(tp, undefined, { nowMs: ms(min) });
  assert.deepStrictEqual(at(60).map((a) => a.id), [NAME], '10 min after its last write');
  assert.strictEqual(scanTranscript(tp, undefined, { nowMs: ms(60) }).pendingMessages.get(NAME).lastSeenMs, ms(50));
  assert.deepStrictEqual(at(71), [], '21 min after its last write');
});
