'use strict';
// Hygiene (mesh redesign Phase 4): ONE per-version marker stamper. Only
// companion/lib/migrations.js (recordRun -> markApplied, gated by the one
// completeness predicate isRunComplete) may write a `completedVersion` for the
// current version. Any other file writing it directly would bypass the
// predicate — the exact shape that stamped partial / lock-busy passes as done.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const PLUGIN = 'plugins/anti-hall/';
const OWNER = 'plugins/anti-hall/companion/lib/migrations.js';

function productionFiles() {
  const r = cp.spawnSync('git', ['ls-files', '-co', '--exclude-standard', PLUGIN], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ls-files failed: ' + r.stderr);
  return r.stdout.split('\n').filter((f) => f.endsWith('.js') && fs.existsSync(path.join(REPO, f)));
}

// A WRITE of the version stamp: `completedVersion: version` (object literal) or
// `.completedVersion = …` (assignment). Preserving a prior value
// (`completedVersion: (state[key] && …) || null`) and reads (`=== version`) are fine.
const WRITE_RE = /completedVersion\s*:\s*(?:version|latest|v)\b|\.completedVersion\s*=(?!=)/;

test('no file but migrations.js writes a per-version completedVersion stamp', () => {
  const hits = [];
  for (const f of productionFiles()) {
    if (f === OWNER) continue;
    fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').forEach((text, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      if (WRITE_RE.test(text)) hits.push(f + ':' + (i + 1) + ': ' + text.trim());
    });
  }
  assert.deepStrictEqual(hits, [], 'route these through migrations.recordRun:\n' + hits.join('\n'));
});

test('self-check: the owner itself matches, so the scan is not vacuous', () => {
  const src = fs.readFileSync(path.join(REPO, OWNER), 'utf8');
  assert.ok(src.split('\n').some((l) => WRITE_RE.test(l)), 'migrations.js must contain the one stamp write');
});
