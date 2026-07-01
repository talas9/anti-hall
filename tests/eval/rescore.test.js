'use strict';
// tests/eval/rescore.test.js — unit tests for eval/rescore.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rescore, selftest } = require('../../eval/rescore.js');

// Synthetic records: 2 protocol (1 fab), 2 baseline (0 fab)
// task 'a': protocol=fab, baseline=clean  → in task_level_differences
// task 'b': both clean                    → not in task_level_differences
const RECORDS = [
  { task_id: 'a', condition: 'protocol', fabricated: true  },
  { task_id: 'b', condition: 'protocol', fabricated: false },
  { task_id: 'a', condition: 'baseline', fabricated: false },
  { task_id: 'b', condition: 'baseline', fabricated: false },
];

test('rescore: protocol n and fabricated count', () => {
  const s = rescore(RECORDS);
  assert.strictEqual(s.protocol.n, 2);
  assert.strictEqual(s.protocol.fabricated, 1);
});

test('rescore: protocol rate', () => {
  const s = rescore(RECORDS);
  assert.strictEqual(s.protocol.rate, 0.5);
});

test('rescore: baseline n, fabricated, rate', () => {
  const s = rescore(RECORDS);
  assert.strictEqual(s.baseline.n, 2);
  assert.strictEqual(s.baseline.fabricated, 0);
  assert.strictEqual(s.baseline.rate, 0);
});

test('rescore: delta_fab_rate', () => {
  const s = rescore(RECORDS);
  assert.strictEqual(s.delta_fab_rate, 0.5);
});

test('rescore: task_level_differences lists only divergent tasks', () => {
  const s = rescore(RECORDS);
  assert.deepStrictEqual(s.task_level_differences, ['a']);
});

test('rescore: empty records → zero counts and no diffs', () => {
  const s = rescore([]);
  assert.strictEqual(s.protocol.n, 0);
  assert.strictEqual(s.protocol.rate, 0);
  assert.strictEqual(s.baseline.n, 0);
  assert.strictEqual(s.baseline.rate, 0);
  assert.strictEqual(s.delta_fab_rate, 0);
  assert.deepStrictEqual(s.task_level_differences, []);
});

test('rescore: warns on fabricated value that is not boolean', () => {
  const s = rescore([
    { task_id: 'x', condition: 'protocol', fabricated: 'yes' },
  ]);
  assert.ok(s.warnings.some((w) => w.includes('fabricated is not boolean')));
});

test('rescore: warns on missing condition', () => {
  const s = rescore([
    { task_id: 'x', fabricated: false },
  ]);
  assert.ok(s.warnings.some((w) => w.includes('condition="undefined"')));
});

// --- selftest ---

test('selftest: passes on self-consistent file', () => {
  const computed = rescore(RECORDS);
  const file = { summary: { ...computed }, records: RECORDS };
  const result = selftest(file);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.failures.length, 0);
});

test('selftest: fails when stored fabricated count is wrong', () => {
  const computed = rescore(RECORDS);
  const file = {
    summary: {
      ...computed,
      protocol: { ...computed.protocol, fabricated: 99 }, // doctored
    },
    records: RECORDS,
  };
  const result = selftest(file);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.length > 0);
  assert.ok(result.failures.some((f) => f.includes('fabricated')));
});

test('selftest: fails when summary block is missing', () => {
  const result = selftest({ records: RECORDS });
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('missing summary block')));
});

test('selftest: fails when records is not an array', () => {
  const result = selftest({ summary: rescore([]), records: { nope: true } });
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('records is not an array')));
});

test('selftest: fails when stored n is wrong', () => {
  const computed = rescore(RECORDS);
  const file = {
    summary: {
      ...computed,
      baseline: { ...computed.baseline, n: 999 }, // doctored
    },
    records: RECORDS,
  };
  const result = selftest(file);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('.n')));
});

test('selftest: fails on record with fabricated not boolean', () => {
  const bad = [
    { task_id: 'x', condition: 'protocol', fabricated: 'yes' }, // string
    { task_id: 'x', condition: 'baseline', fabricated: false  },
  ];
  const file = { summary: rescore([{ task_id: 'x', condition: 'protocol', fabricated: false }, { task_id: 'x', condition: 'baseline', fabricated: false }]), records: bad };
  const result = selftest(file);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('not boolean')));
});

test('selftest: fails on record with invalid condition', () => {
  const bad = [
    { task_id: 'x', condition: 'unknown', fabricated: false },
  ];
  const file = { summary: rescore([]), records: bad };
  const result = selftest(file);
  assert.strictEqual(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('condition')));
});

test('reporting CLI: warns on duplicate task_id+condition across aggregate files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rescore-'));
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(a, JSON.stringify({
    records: [
      { task_id: 'dup', condition: 'protocol', fabricated: false },
    ],
  }));
  fs.writeFileSync(b, JSON.stringify({
    records: [
      { task_id: 'dup', condition: 'protocol', fabricated: true },
    ],
  }));

  const result = spawnSync(process.execPath, ['eval/rescore.js', a, b], {
    cwd: path.join(__dirname, '../..'),
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0);
  assert.match(result.stderr, /duplicate task_id\+condition/);
  assert.match(result.stderr, /dup\+protocol/);
  assert.match(result.stderr, /a\.json/);
  assert.match(result.stderr, /b\.json/);
});
