'use strict';
// Runs tests/update/ah-update-errors.sh: every failure class of ah-update.sh says what failed, the state it left and one next step (#143).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('ah-update.sh failure messages: what failed, the state, one next step', { timeout: 180000 }, () => {
  const r = spawnSync('sh', [path.join(__dirname, 'ah-update-errors.sh')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
