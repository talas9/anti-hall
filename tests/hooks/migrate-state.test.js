'use strict';
// tests/hooks/migrate-state.test.js — unit tests for migrate-state.js
// Uses a temp dir per test (script lives under plugins/anti-hall/scripts/,
// but its test follows this repo's tests/hooks/ convention — see
// harvest-debt.test.js for the same pattern).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyState } = require('../../plugins/anti-hall/scripts/migrate-state.js');

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-state-test-'));
  function write(name, content) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
  }
  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return { dir, write, cleanup };
}

test('migrates both legacy files into .anti-hall/history/legacy/', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.anti-hall-progress.md', '# progress\n- did stuff\n');
    write('.anti-hall-history.md', '# history\n- fixed stuff\n');

    const results = migrateLegacyState({ dir });
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.action === 'migrated'));

    const destProgress = path.join(dir, '.anti-hall', 'history', 'legacy', '.anti-hall-progress.md');
    const destHistory = path.join(dir, '.anti-hall', 'history', 'legacy', '.anti-hall-history.md');
    assert.strictEqual(fs.readFileSync(destProgress, 'utf8'), '# progress\n- did stuff\n');
    assert.strictEqual(fs.readFileSync(destHistory, 'utf8'), '# history\n- fixed stuff\n');
  } finally { cleanup(); }
});

test('idempotent: second run is a no-op that reports skipped, not duplicated', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.anti-hall-progress.md', '# progress\n- did stuff\n');

    const first = migrateLegacyState({ dir });
    assert.strictEqual(first[0].action, 'migrated');

    const destPath = first[0].dest;
    const afterFirstRun = fs.readFileSync(destPath, 'utf8');

    const second = migrateLegacyState({ dir });
    assert.strictEqual(second[0].action, 'skipped');
    assert.strictEqual(
      fs.readFileSync(destPath, 'utf8'),
      afterFirstRun,
      'destination content unchanged on re-run'
    );
  } finally { cleanup(); }
});

test('non-destructive: original legacy files are byte-for-byte unchanged after migration', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    const original = '# progress\n- line one\n- line two\n';
    const srcPath = write('.anti-hall-progress.md', original);

    migrateLegacyState({ dir });
    migrateLegacyState({ dir }); // run twice to be sure

    assert.strictEqual(fs.readFileSync(srcPath, 'utf8'), original);
  } finally { cleanup(); }
});

test('lossless: full original content is present in the migrated copy', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    const original = '# history\n' + 'line\n'.repeat(500);
    write('.anti-hall-history.md', original);

    const results = migrateLegacyState({ dir });
    const migrated = results.find((r) => r.file === '.anti-hall-history.md');
    assert.strictEqual(fs.readFileSync(migrated.dest, 'utf8'), original);
  } finally { cleanup(); }
});

test('fail-open: no legacy files present does not throw and reports not-found', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const results = migrateLegacyState({ dir });
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.action === 'not-found'));
  } finally { cleanup(); }
});

test('creates missing .anti-hall/history/legacy/ directory tree', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    assert.ok(!fs.existsSync(path.join(dir, '.anti-hall')));
    write('.anti-hall-progress.md', '# progress\n');

    migrateLegacyState({ dir });

    assert.ok(fs.existsSync(path.join(dir, '.anti-hall', 'history', 'legacy')));
  } finally { cleanup(); }
});

test('only one legacy file present: migrates that one, reports not-found for the other', () => {
  const { dir, write, cleanup } = makeTmpDir();
  try {
    write('.anti-hall-progress.md', '# progress only\n');

    const results = migrateLegacyState({ dir });
    const progress = results.find((r) => r.file === '.anti-hall-progress.md');
    const history = results.find((r) => r.file === '.anti-hall-history.md');
    assert.strictEqual(progress.action, 'migrated');
    assert.strictEqual(history.action, 'not-found');
  } finally { cleanup(); }
});
