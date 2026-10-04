'use strict';
// scripts/hook-latency.js --grouped: one parallel group per event scenario, with
// group wall and summed CPU. Kept tiny (n=2, one hook) so it stays fast.
const test = require('node:test');
const assert = require('node:assert');
const { benchGrouped, markdownGrouped, parseArgs } = require('../scripts/hook-latency.js');

test('parseArgs reads --grouped', () => {
  assert.strictEqual(parseArgs(['--grouped']).grouped, true);
  assert.strictEqual(parseArgs([]).grouped, false);
});

test('benchGrouped reports one group per event with wall and CPU', async () => {
  const rep = await benchGrouped({ n: 2, only: new Set(['verify-first']) });
  assert.ok(rep.groups.length >= 1);
  for (const g of rep.groups) {
    assert.ok(g.hooks >= 1);
    assert.strictEqual(g.samples, 1);
    assert.ok(g.wall.p50 > 0);
    assert.ok(g.cpu === null || g.cpu.p50 >= 0);
  }
  const md = markdownGrouped(rep);
  assert.match(md, /\| Event \| Scenario \| Hooks \| Wall p50 \|/);
});
