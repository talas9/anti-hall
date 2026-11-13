'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../plugins/anti-hall/engine/logic/silent-agent-nudge.js'), 'utf8');

function fixture({ state = null, answers = [], rows = [], live = null, budget = 1024 } = {}) {
  let now = 10_000; const words = { stop: 'stop', acted: 'acted', msg: 'msg', snooze: 'snooze', other: 'other' };
  const files = new Map();
  if (state !== null) files.set('/fixture/tracker/state.json', JSON.stringify(state));
  files.set('/fixture/tracker/answers.ndjson', answers.map(a => JSON.stringify(a)).join('\n') + '\n');
  const cfg = {
    'silent_nudge.rt_reconcile_bytes': budget, 'silent_nudge.rt_answers_bytes': 1024,
    'script.read_max_bytes': 8192, 'agent_tracker.paths': { base: '', dir: 'tracker', state: 'state.json' },
    'agent_nudge.paths': { answers: 'answers.ndjson' }, 'agent_nudge.answers': words,
    'agent_nudge.limits': { window_ms: 1000, snooze_default_min: 30, snooze_min_min: 1, snooze_max_min: 60 },
    'silent_nudge.rt_first_seen': { file: 'runtime-first-seen.json', max_bytes: 4096, max_rows: 4, ttl_ms: 20000, skew_ms: 1000, initial_window_ms: 1000 },
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
    }, state: { writeAtomic: (p, raw) => { files.set(normalize('/fixture/' + p), raw); return true; } }, transcript: { trackedAgents: () => [], trackedLiveness: () => live },
  }, jx: { parse: raw => { try { return { v: JSON.parse(raw) }; } catch { return { invalid: true }; } }, isObj: v => v !== null && typeof v === 'object' && !Array.isArray(v) } });
  vm.runInContext(source, context);
  const evidence = context.snRuntimeEvidence({ session_id: 'parent' }, '/fixture', undefined, rows);
  const publishers = rows.length ? rows : [{ session: 'parent', child: 'child', name: 'worker', block: true }];
  function observe(current = publishers) {
    const e = context.snRuntimeEvidence({ session_id: 'parent' }, '/fixture', undefined, current);
    if (context.snRuntimeFirstSeen) e.firstSeen = context.snRuntimeFirstSeen('/fixture', current, now);
    return context.snRuntimeVerdict('child', 'worker', 'parent', e);
  }
  return { evidence, tails, verdict: observe, observe, files, cfg, advance: ms => { now += ms; }, answer: (answer, ts = now) => files.set('/fixture/tracker/answers.ndjson', JSON.stringify({ child: 'child', answer, ts }) + '\n') };

}

test('oversized state cannot consume the independent owner-answer budget', () => {
  const f = fixture({ state: { history: 'x'.repeat(2048) }, answers: [{ child: 'child', answer: 'other', ts: 9000 }] });
  assert.equal(f.tails, 1);
  assert.equal(f.verdict().retired, true);
});
test('stop answers survive missing state', () => {
  assert.equal(fixture({ answers: [{ child: 'child', answer: 'stop', ts: 9500 }] }).verdict().retired, true);
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

for (const answer of ['stop', 'acted', 'other']) test(`unreadable state rejects ancient ${answer} for a new escalation`, () => {
  const f = fixture({ state: { history: 'x'.repeat(2048) }, answers: [{ child: 'child', answer, ts: 1 }] });
  assert.notEqual(f.verdict().retired, true);
});
test('a fresh answer after first observation releases the block', () => {
  const f = fixture();
  assert.notEqual(f.observe().retired, true);
  f.advance(2000); f.answer('acted');
  assert.equal(f.observe().retired, true);
});
test('disappearance and re-escalation require a new answer', () => {
  const f = fixture();
  f.observe(); f.advance(2000); f.answer('stop');
  assert.equal(f.observe().retired, true);
  f.observe([]); f.advance(2000);
  assert.notEqual(f.observe().retired, true);
  f.answer('stop'); assert.equal(f.observe().retired, true);
});
test('a stop answer cannot renew its lifetime on repeated evaluation', () => {
  const f = fixture(); f.observe(); f.answer('stop');
  assert.equal(f.observe().retired, true);
  f.advance(2000);
  assert.notEqual(f.observe().retired, true);
});
test('growing answer history remains a bounded tail and retains only fresh answers', () => {
  const f = fixture(); f.observe();
  for (let n = 0; n < 5; n++) {
    f.advance(2000);
    f.files.set('/fixture/tracker/answers.ndjson', (JSON.stringify({ padding: 'x'.repeat(2048) }) + '\n' + JSON.stringify({ child: 'child', answer: 'stop', ts: 1 }) + '\n').repeat(n + 1));
    assert.notEqual(f.observe().retired, true);
    f.files.set('/fixture/tracker/answers.ndjson', f.files.get('/fixture/tracker/answers.ndjson') + JSON.stringify({ child: 'child', answer: 'other', ts: 10000 + 2000 * (n + 1) }) + '\n');
    assert.equal(f.observe().retired, true);
  }
});

test('expired anchors restart conservatively and reject the earlier answer', () => {
  const f = fixture(); f.observe(); f.answer('other');
  assert.equal(f.observe().retired, true);
  f.advance(f.cfg['silent_nudge.rt_first_seen'].ttl_ms + 1);
  assert.notEqual(f.observe().retired, true);
});
test('anchor row cap fails closed for overflow and prunes disappeared rows', () => {
  const f = fixture(); f.cfg['silent_nudge.rt_first_seen'].max_rows = 1;
  f.answer('stop');
  const row = { session: 'parent', child: 'child', name: 'worker' };
  assert.notEqual(f.observe([{ session: 'other', child: 'other-child' }, row]).retired, true);
  assert.equal(f.observe([row]).retired, true);
  f.observe([]);
  assert.equal(f.files.get('/fixture/tracker/runtime-first-seen.json'), '{}');
});
test('anchor UTF-8 byte cap fails closed and stays bounded', () => {
  const f = fixture(); f.cfg['silent_nudge.rt_first_seen'].max_bytes = 2;
  f.answer('stop');
  assert.notEqual(f.observe().retired, true);
  assert.equal(Buffer.byteLength(f.files.get('/fixture/tracker/runtime-first-seen.json')), 2);
});
test('corrupt observation clocks cannot inherit an ancient answer', () => {
  const f = fixture({ answers: [{ child: 'child', answer: 'acted', ts: 1 }] });
  f.files.set('/fixture/tracker/runtime-first-seen.json', '{');
  assert.notEqual(f.observe().retired, true);
});
