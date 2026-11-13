'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../plugins/anti-hall/engine/logic/silent-agent-nudge.js'), 'utf8');

function fixture({ state = null, answers = [], rows = [], live = null, budget = 1024 } = {}) {
  const now = 10_000, words = { stop: 'stop', acted: 'acted', msg: 'msg', snooze: 'snooze', other: 'other' };
  const files = new Map();
  if (state !== null) files.set('/fixture/tracker/state.json', JSON.stringify(state));
  files.set('/fixture/tracker/answers.ndjson', answers.map(a => JSON.stringify(a)).join('\n') + '\n');
  const cfg = {
    'silent_nudge.rt_reconcile_bytes': budget, 'silent_nudge.rt_answers_bytes': 1024,
    'script.read_max_bytes': 8192, 'agent_tracker.paths': { base: '', dir: 'tracker', state: 'state.json' },
    'agent_nudge.paths': { answers: 'answers.ndjson' }, 'agent_nudge.answers': words,
    'agent_nudge.limits': { window_ms: 1000, snooze_default_min: 30, snooze_min_min: 1, snooze_max_min: 60 },
    'agent_tracker.fmt': { unit_ms: [1, 60000] }, 'silent_nudge.rt_repair': { ttl_ms: 1000 },
  };
  const normalize = p => p.replace('//', '/');
  let tails = 0;
  const context = vm.createContext({ ah: {
    cfg: k => cfg[k], cfgNum: k => cfg[k], cfgLive: k => cfg[k], metric() {}, clock: { now: () => now },
    fs: {
      size: p => files.has(normalize(p)) ? Buffer.byteLength(files.get(normalize(p))) : null,
      readText: (p, max) => {
        const raw = files.get(normalize(p));
        assert.ok(raw === undefined || Buffer.byteLength(raw) <= max, 'whole oversized file must not enter QuickJS');
        return raw ?? null;
      },
      tailLines: (p, max) => {
        tails++;
        const raw = files.get(normalize(p));
        if (raw === undefined) return null;
        const bytes = Buffer.from(raw), cut = bytes.length > max;
        const text = bytes.subarray(Math.max(0, bytes.length - max)).toString('utf8');
        return (cut ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
      },
    }, transcript: { trackedAgents: () => [], trackedLiveness: () => live },
  }, jx: { parse: raw => { try { return { v: JSON.parse(raw) }; } catch { return { invalid: true }; } } } });
  vm.runInContext(source, context);
  const evidence = context.snRuntimeEvidence({ session_id: 'parent' }, '/fixture', undefined, rows);
  return { evidence, tails, verdict: () => context.snRuntimeVerdict('child', 'worker', 'parent', evidence) };
}

test('oversized state cannot consume the independent owner-answer budget', () => {
  const f = fixture({ state: { history: 'x'.repeat(2048) }, answers: [{ child: 'child', answer: 'other', ts: 9000 }] });
  assert.equal(f.tails, 1);
  assert.equal(f.verdict().retired, true);
});
test('stop answers survive missing state', () => {
  assert.equal(fixture({ answers: [{ child: 'child', answer: 'stop', ts: 9000 }] }).verdict().retired, true);
});
test('publisher name resolves when tracker state is missing', () => {
  const f = fixture({ rows: [{ session: 'parent', child: 'child', name: 'worker' }], answers: [{ child: 'worker', answer: 'other', ts: 9000 }] });
  assert.equal(f.verdict().retired, true);
});
test('an ambiguous publisher name cannot release another session', () => {
  const f = fixture({ rows: [{ session: 'parent', child: 'child', name: 'worker' }, { session: 'other', child: 'other-child', name: 'worker' }], answers: [{ child: 'worker', answer: 'stop', ts: 9000 }] });
  assert.notEqual(f.verdict().retired, true);
});
test('newest timestamp wins across id and name aliases', () => {
  const f = fixture({ rows: [{ session: 'parent', child: 'child', name: 'worker' }], answers: [{ child: 'worker', answer: 'other', ts: 9000 }, { child: 'child', answer: 'msg', ts: 100 }] });
  assert.equal(f.verdict().retired, true);
  assert.equal(f.verdict().answer_at, 9000);
});
test('readable incarnation timestamps still reject old stop answers', () => {
  const f = fixture({ state: { agents: { child: { parent: 'parent', running: true, first_seen: 9500 } } }, answers: [{ child: 'child', answer: 'stop', ts: 9000 }] });
  assert.equal(f.verdict().retired, false);
});
test('live completion still reconciles an oversized tracker without an answer', () => {
  assert.equal(fixture({ state: { history: 'x'.repeat(2048) }, live: false }).verdict().retired, true);
});
