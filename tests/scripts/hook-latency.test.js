'use strict';
// Shape-only test for scripts/hook-latency.js: 2 hooks, N=3. Asserts the report
// structure, never a timing value, so it cannot flake on a loaded machine.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const cp = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'hook-latency.js');
const ARGS = ['-n', '3', '--only', 'git-guard,verify-first'];

function run(extra) {
  const r = cp.spawnSync(process.execPath, [SCRIPT, ...ARGS, ...extra], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ': ' + r.stderr);
  return r.stdout;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

test('--json report has the documented shape', () => {
  const rep = JSON.parse(run(['--json']));
  assert.strictEqual(rep.meta.n, 3);
  assert.ok(rep.meta.node && rep.meta.cpu && rep.meta.date, 'meta carries node, cpu, date');
  assert.strictEqual(rep.meta.loadavg.length, 3);
  assert.ok(rep.meta.parallel, 'meta records the parallel-vs-sequential source');
  assert.ok(rep.hooks.length >= 2, 'at least both hooks measured');
  for (const h of rep.hooks) {
    assert.ok(h.event && h.scenario && h.hook, 'row identity');
    assert.strictEqual(h.samples, 2, 'N=3 minus the dropped first run');
    assert.ok(isNum(h.wall.p50) && isNum(h.wall.p95), 'wall p50/p95');
    assert.ok(h.cpu === null || (isNum(h.cpu.p50) && isNum(h.cpu.p95)), 'cpu is null or p50/p95');
    assert.strictEqual(h.loadavg.length, 3);
  }
  assert.ok(rep.totals.length >= 1);
  for (const t of rep.totals) {
    assert.ok(t.event && t.scenario && t.hooks >= 1);
    assert.ok(isNum(t.wall_max_p50) && isNum(t.wall_sum_p50), 'labelled max and sum');
    assert.ok(isNum(t.wall_parallel_p50) && isNum(t.wall_parallel_p95), 'measured parallel wall');
    assert.ok(t.cpu_sum_p50 === null || isNum(t.cpu_sum_p50));
  }
});

test('default output is a markdown table', () => {
  const md = run([]);
  assert.match(md, /\| Event \| Scenario \| Hook \|/);
  assert.match(md, /\| Event \| Scenario \| Hooks \|/);
});
