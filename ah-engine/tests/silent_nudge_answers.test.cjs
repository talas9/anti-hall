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
    'stop_reblock.lock': { suffix: '.flock', group: 'handovers', wait_ms: 0 }, 'silent_nudge.rt_reconcile_bytes': budget, 'silent_nudge.rt_answers_bytes': 1024,
    'script.read_max_bytes': 8192, 'agent_tracker.paths': { base: '', dir: 'tracker', state: 'state.json' },
    'agent_nudge.paths': { answers: 'answers.ndjson' }, 'agent_nudge.runtime_escalation': { file: 'runtime-escalations.json' }, 'agent_nudge.answers': words,
    'agent_nudge.limits': { window_ms: 1000, snooze_default_min: 30, snooze_min_min: 1, snooze_max_min: 60 },
    'silent_nudge.rt_first_seen': { file: 'runtime-first-seen.json', max_bytes: 4096, max_rows: 4, ttl_ms: 20000, skew_ms: 1000, initial_window_ms: 1000, future_allowance_ms: 2000, backdate_max_ms: 60000 },
    'agent_tracker.fmt': { unit_ms: [1, 60000] }, 'silent_nudge.rt_repair': { ttl_ms: 1000 },
  };
  const normalize = p => p.replace('//', '/');
  let tails = 0, locked = false;
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
    }, state: { flock: () => { if (locked) return 'busy'; locked = true; return 1; }, unlock: () => { locked = false; }, writeAtomic: (p, raw) => { files.set(normalize('/fixture/' + p), raw); return true; } }, transcript: { trackedAgents: () => [], trackedLiveness: () => live },
  }, jx: { parse: raw => { try { return { v: JSON.parse(raw) }; } catch { return { invalid: true }; } }, isObj: v => v !== null && typeof v === 'object' && !Array.isArray(v) } });
  vm.runInContext(source, context);
  const evidence = context.snRuntimeEvidence({ session_id: 'parent' }, '/fixture', undefined, rows);
  const publishers = rows.length ? rows : [{ session: 'parent', child: 'child', name: 'worker', block: true }];
  function observe(current = publishers) {
    files.set('/fixture/tracker/runtime-escalations.json', JSON.stringify({ rows: current }));
    const e = context.snRuntimeEvidence({ session_id: 'parent' }, '/fixture', undefined, current);
    if (context.snRuntimeFirstSeen) e.firstSeen = context.snRuntimeFirstSeen('/fixture', current, now, e.state);
    return context.snRuntimeVerdict('child', 'worker', 'parent', e);
  }
  return { context, publishers, evidence, tails, verdict: observe, observe, files, cfg, advance: ms => { now += ms; }, answer: (answer, ts = now) => files.set('/fixture/tracker/answers.ndjson', JSON.stringify({ child: 'child', answer, ts }) + '\n') };

}

test('oversized state cannot consume the independent owner-answer budget', () => {
  const f = fixture({ state: { history: 'x'.repeat(2048) }, answers: [{ child: 'child', answer: 'other', ts: 10000 }] });
  assert.equal(f.tails, 1);
  assert.equal(f.verdict().retired, true);
});
test('stop answers survive missing state', () => {
  assert.equal(fixture({ answers: [{ child: 'child', answer: 'stop', ts: 10000 }] }).verdict().retired, true);
});
test('publisher name resolves when tracker state is missing', () => {
  const f = fixture({ rows: [{ session: 'parent', child: 'child', name: 'worker' }], answers: [{ child: 'worker', answer: 'other', ts: 10000 }] });
  assert.equal(f.verdict().retired, true);
});
test('an ambiguous publisher name cannot release another session', () => {
  const f = fixture({ rows: [{ session: 'parent', child: 'child', name: 'worker' }, { session: 'other', child: 'other-child', name: 'worker' }], answers: [{ child: 'worker', answer: 'stop', ts: 10000 }] });
  assert.notEqual(f.verdict().retired, true);
});
test('newest timestamp wins across id and name aliases', () => {
  const f = fixture({ rows: [{ session: 'parent', child: 'child', name: 'worker' }], answers: [{ child: 'worker', answer: 'other', ts: 10000 }, { child: 'child', answer: 'msg', ts: 100 }] });
  assert.equal(f.verdict().retired, true);
  assert.equal(f.verdict().answer_at, 10000);
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
  const f = fixture(); f.cfg['silent_nudge.rt_first_seen'].max_bytes = 80;
  const row = { session: 'parent', child: 'é'.repeat(12) };
  const candidate = JSON.stringify({ [JSON.stringify([row.session, row.child])]: { at: 10000, reminders: null, block: false } });
  assert.ok(candidate.length <= 80 && Buffer.byteLength(candidate) > 80, 'only UTF-8 byte accounting catches this overflow');
  f.observe([row]);
  assert.equal(f.files.get('/fixture/tracker/runtime-first-seen.json'), '{}');
});

test('corrupt observation clocks cannot inherit an ancient answer', () => {
  const f = fixture({ answers: [{ child: 'child', answer: 'acted', ts: 1 }] });
  f.files.set('/fixture/tracker/runtime-first-seen.json', '{');
  assert.notEqual(f.observe().retired, true);
});

for (const answer of ['acted', 'other']) test(`answer just before re-escalation first-seen cannot release ${answer}`, () => {
  const f = fixture({ state: { history: 'x'.repeat(2048) } });
  f.observe(); f.advance(2000); f.answer(answer);
  assert.equal(f.observe().retired, true);
  f.observe([]); f.advance(500);
  assert.notEqual(f.observe().retired, true);
});
test('a delayed stale observer cannot roll back anchors or drop a newer child', () => {
  const f = fixture();
  const oldRows = [{ session: 'parent', child: 'child', reminders: 4, dur_ms: 10000 }];
  f.observe(oldRows); f.observe([]); f.advance(15000);
  const newRows = [{ session: 'parent', child: 'child', reminders: 1, dur_ms: 500 }, { session: 'parent', child: 'new-child', reminders: 1, dur_ms: 500 }];
  f.observe(newRows);
  const before = f.files.get('/fixture/tracker/runtime-first-seen.json');
  f.context.snRuntimeFirstSeen('/fixture', oldRows, 10000);
  assert.equal(f.files.get('/fixture/tracker/runtime-first-seen.json'), before);
  f.answer('other', 12000);
  assert.notEqual(f.observe(newRows).retired, true);
});

test('a genuine publisher reminder requires a fresh answer', () => {
  const f = fixture();
  const row = { session: 'parent', child: 'child', reminders: 1, dur_ms: 10000 };
  f.observe([row]); f.advance(2000); f.answer('other');
  assert.equal(f.observe([row]).retired, true);
  f.advance(500);
  assert.notEqual(f.observe([{ ...row, reminders: 2, dur_ms: 12500 }]).retired, true);
  f.answer('other');
  assert.equal(f.observe([{ ...row, reminders: 2, dur_ms: 12500 }]).retired, true);
});
test('a held anchor lock prevents a competing writer and failed acquisition never releases', () => {
  const f = fixture(); f.observe(); f.answer('other');
  const before = f.files.get('/fixture/tracker/runtime-first-seen.json');
  const h = f.context.ah.state.flock();
  assert.notEqual(f.observe().retired, true);
  assert.equal(f.files.get('/fixture/tracker/runtime-first-seen.json'), before);
  f.context.ah.state.unlock(h);
  assert.equal(f.observe().retired, true);
  for (const outcome of ['failed', null]) {
    f.context.ah.state.flock = () => outcome;
    assert.notEqual(f.observe().retired, true);
  }
});
test('a block-tier transition requires a fresh answer even at unchanged counters', () => {
  const f = fixture();
  const row = { session: 'parent', child: 'child', reminders: 1, dur_ms: 10000, block: false };
  f.observe([row]); f.advance(2000); f.answer('other');
  assert.equal(f.observe([row]).retired, true);
  f.advance(500);
  assert.notEqual(f.observe([{ ...row, block: true }]).retired, true);
});
test('successive generations retain their newest anchors across delayed observers', () => {
  const f = fixture();
  const first = [{ session: 'parent', child: 'child', reminders: 1, dur_ms: 10000 }];
  f.observe(first); f.advance(15000);
  const second = [{ ...first[0], reminders: 2, dur_ms: 25000 }];
  f.observe(second); f.advance(1000);
  const third = [{ ...first[0], reminders: 3, dur_ms: 26000 }, { session: 'parent', child: 'new-child', dur_ms: 1000 }];
  f.observe(third);
  const before = f.files.get('/fixture/tracker/runtime-first-seen.json');
  f.context.snRuntimeFirstSeen('/fixture', second, 25000);
  f.context.snRuntimeFirstSeen('/fixture', first, 10000);
  assert.equal(f.files.get('/fixture/tracker/runtime-first-seen.json'), before);
  f.answer('other', 25500);
  assert.notEqual(f.observe(third).retired, true);
  f.answer('other');
  assert.equal(f.observe(third).retired, true);
});

test('an answer stays accepted across many ordinary publisher duration ticks', () => {
  const f = fixture();
  f.cfg['silent_nudge.rt_first_seen'].ttl_ms = 86400000;
  const row = { session: 'parent', child: 'child', reminders: 2, block: true, dur_ms: 10000 };
  f.observe([row]); f.advance(100); f.answer('other');
  assert.equal(f.observe([row]).retired, true);
  for (let tick = 1; tick <= 20; tick++) {
    f.advance(60000 + (tick % 2 ? 5000 : -5000));
    assert.equal(f.observe([{ ...row, dur_ms: 10000 + tick * 60000 }]).retired, true, `ordinary tick ${tick}`);
  }
});
for (const offset of [2001, Number.MAX_SAFE_INTEGER]) test(`future anchor ${offset} is replaced, then a fresh answer releases`, () => {
  const f = fixture();
  const row = { session: 'parent', child: 'child', reminders: 2, block: true, dur_ms: 10000 };
  const key = JSON.stringify(['parent', 'child']);
  f.files.set('/fixture/tracker/runtime-first-seen.json', JSON.stringify({ [key]: { at: 10000 + offset, reminders: 2, block: true, dur_ms: 10000 } }));
  f.answer('other', 9999);
  assert.notEqual(f.observe([row]).retired, true);
  assert.equal(JSON.parse(f.files.get('/fixture/tracker/runtime-first-seen.json'))[key].at, 10000);
  f.advance(100); f.answer('other');
  assert.equal(f.observe([row]).retired, true);
});
test('future allowance boundary keeps a valid anchor without rollback', () => {
  const f = fixture();
  const key = JSON.stringify(['parent', 'child']);
  f.files.set('/fixture/tracker/runtime-first-seen.json', JSON.stringify({ [key]: { at: 12000, reminders: null, block: true } }));
  f.observe();
  assert.equal(JSON.parse(f.files.get('/fixture/tracker/runtime-first-seen.json'))[key].at, 12000);
});

// #751: the coordinator answers after a re-escalation but before its own Stop first sees the new generation.
function reescalated(answerTs) {
  const f = fixture();
  const setSent = (sent, reminders) => {
    f.files.set('/fixture/tracker/state.json', JSON.stringify({ nudges: { n1: { child: 'child', parent: 'parent', last_sent: sent, reminders } } }));
    return [{ session: 'parent', child: 'child', name: 'worker', reminders, block: true }];
  };
  f.observe(setSent(9500, 3));
  f.advance(10000);
  const rows = setSent(19000, 4);
  f.answer('other', answerTs);
  return f.observe(rows);
}
test('answer after the re-escalation but before the Stop first sees it clears the block', () => {
  assert.equal(reescalated(19500).retired, true);
});
test('answer from before the re-escalation does not clear the new generation', () => {
  assert.notEqual(reescalated(18000).retired, true);
});
test('a block-tier change without a new send does not backdate the anchor', () => {
  const f = fixture();
  f.files.set('/fixture/tracker/state.json', JSON.stringify({ nudges: { n1: { child: 'child', parent: 'parent', last_sent: 9500 } } }));
  f.observe([{ session: 'parent', child: 'child', name: 'worker', reminders: 3, block: false }]);
  f.advance(10000); f.answer('other', 15000);
  assert.notEqual(f.observe([{ session: 'parent', child: 'child', name: 'worker', reminders: 3, block: true }]).retired, true);
});
