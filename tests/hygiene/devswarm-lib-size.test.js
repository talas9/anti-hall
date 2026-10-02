'use strict';
// Hygiene: every file under plugins/anti-hall/scripts/devswarm-lib/ stays at or
// below 256 KiB (262,144 bytes). The devswarm.js split exists to keep each shipped
// file small enough for the plugin directory validator's per-file read limit; a
// module that grows past the cap must be split again, not allowed to creep.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm-lib');
const CAP = 256 * 1024;

test('every devswarm-lib file is <= 262,144 bytes', () => {
  const files = fs.readdirSync(LIB).filter((n) => n.endsWith('.js'));
  assert.ok(files.length > 0, 'devswarm-lib/ holds modules');
  const over = files.map((n) => [n, fs.statSync(path.join(LIB, n)).size]).filter(([, size]) => size > CAP);
  assert.deepStrictEqual(over, [], 'files over ' + CAP + ' bytes: ' + JSON.stringify(over));
});
