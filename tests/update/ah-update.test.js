'use strict';
// Runs tests/update/ah-update.sh (scratch HOME, fake engines, local http server and git repo; no real network).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('ah-update.sh shell tests pass', { timeout: 180000 }, () => {
  const r = spawnSync('sh', [path.join(__dirname, 'ah-update.sh')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
