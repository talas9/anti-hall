'use strict';
// Tests never touch the real home (repo rule). Leaks came through tests that
// called runUpdate() / runRepairs() / runMigrations() without an isolated
// HOME, so a stage fell back to os.homedir() and repaired the developer's real
// ~/.anti-hall. Those three entry points now REFUSE (throw) under
// `node --test` when their home is the real passwd home — so every such test
// fails loudly instead of leaking. This file proves the refusal (without ever
// running a stage) and that an isolated home passes the check.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const guard = require(path.join(ROOT, 'companion', 'lib', 'test-home-guard.js'));
const REAL = os.userInfo().homedir;

test('the guard recognises the real home under node --test, and never outside it', () => {
  assert.strictEqual(guard.realHomeUnderTest(REAL), true);
  assert.strictEqual(guard.realHomeUnderTest(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-thg-'))), false);
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { assert.strictEqual(guard.realHomeUnderTest(REAL, {}), false, 'production is unaffected'); }
  finally { process.env.NODE_TEST_CONTEXT = saved; }
});

test('runRepairs / runMigrations refuse the real home before doing anything', () => {
  const repair = require(path.join(ROOT, 'hooks', 'lib', 'doctor-repair.js'));
  const migrations = require(path.join(ROOT, 'companion', 'lib', 'migrations.js'));
  assert.throws(() => repair.runRepairs({ home: REAL, cwd: os.tmpdir(), env: { HOME: REAL }, dryRun: true }), /REAL user home/);
  assert.throws(() => migrations.runMigrations({ home: REAL, dryRun: true }), /REAL user home/);
});

test('runUpdate refuses when os.homedir() is the real home', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = REAL; process.env.USERPROFILE = REAL;
  try {
    const U = require(path.join(ROOT, 'skills', 'update', 'scripts', 'update.js'));
    assert.throws(() => U.runUpdate({ paths: {} }), /REAL user home/);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
  }
});

test('every entry point carries the guard (a new one must add it)', () => {
  for (const f of ['hooks/lib/doctor-repair.js', 'companion/lib/migrations.js', 'skills/update/scripts/update.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /realHomeUnderTest\(/, f);
  }
});
