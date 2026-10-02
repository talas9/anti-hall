'use strict';
// Hygiene: EVERY file tracked under plugins/anti-hall stays at or below 256 KiB
// (262,144 bytes) -- the plugin directory validator's per-file read limit. The
// directory icon (no longer shipped) was once 569,983 bytes and tripped it; it is now 512x512.
// A file that grows past the cap must be shrunk or split, not allowed to creep.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CAP = 256 * 1024;

// Explicit allow-list of tracked files permitted to exceed the cap (none today).
const ALLOW = new Set([]);

test('every tracked file under plugins/anti-hall is <= 262,144 bytes', () => {
  const r = spawnSync('git', ['ls-files', '-z', 'plugins/anti-hall'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ls-files failed: ' + r.stderr);
  const files = r.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'plugins/anti-hall has tracked files');
  const over = files
    .filter((f) => !ALLOW.has(f))
    .map((f) => [f, fs.statSync(path.join(ROOT, f)).size])
    .filter(([, size]) => size > CAP);
  assert.deepStrictEqual(over, [], 'files over ' + CAP + ' bytes: ' + JSON.stringify(over));
});
