'use strict';
// autoArchivedStateMigratePostUpdate — the update.js post-pull stage wiring
// for the 0.108.4 durable gate-(h) state migration (companion/lib/
// devswarm-lifecycle.js's migrateAutoArchivedState). Mirrors
// gateIntentsMigratePostUpdate's own shape/gate/fail-open posture exactly;
// this test proves the WIRING (gate, delegate call, report shape), not the
// migration's own logic (already covered in tests/companion/
// devswarm-lifecycle.test.js's MIGRATION suite).
//
// Isolated HOME/cwd per fixture (repo rule: tests never touch the real
// home) — autoArchivedStateMigratePostUpdate takes `home`/`cwd` explicitly
// and never falls back to os.homedir()/process.cwd() when passed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { autoArchivedStateMigratePostUpdate } = require('../../plugins/anti-hall/skills/update/scripts/update.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PATHS = { pluginSrcDir: path.join(REPO_ROOT, 'plugins', 'anti-hall') };
const DEVSWARM_ENV = { DEVSWARM_REPO_ID: 'test-repo' };

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-aamigrate-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-aamigrate-cwd-'));
  return {
    home, cwd,
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test('gate CLOSED (non-DevSwarm session) -> never attempted, no state file written', () => {
  const fx = makeFixture();
  try {
    const r = autoArchivedStateMigratePostUpdate({ paths: PATHS, env: {}, cwd: fx.cwd, home: fx.home });
    assert.strictEqual(r.attempted, false);
    assert.match(r.detail, /not a DevSwarm session/);
    assert.ok(!fs.existsSync(path.join(fx.home, '.anti-hall', 'devswarm', 'auto-archived.json')));
  } finally { fx.cleanup(); }
});

test('gate OPEN (DevSwarm session) + no ndjson log at all -> attempted, nothing pending, never fails', () => {
  const fx = makeFixture();
  try {
    const r = autoArchivedStateMigratePostUpdate({ paths: PATHS, env: DEVSWARM_ENV, cwd: fx.cwd, home: fx.home });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.scanned, 0);
    assert.strictEqual(r.migrated, 0);
    assert.strictEqual(r.errors, 0);
  } finally { fx.cleanup(); }
});

test('gate OPEN + a legacy log-only auto-archive record -> migrates it into the durable state file', () => {
  const fx = makeFixture();
  try {
    const logsDir = path.join(fx.home, '.anti-hall', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const rec = { ts: '2026-01-01T00:00:00.000Z', at: 1000, action: 'auto-archive', id: 'ws-1', doneHead: 'h1', ok: true };
    fs.writeFileSync(path.join(logsDir, 'devswarm-auto-archive.ndjson'), JSON.stringify(rec) + '\n');

    const r = autoArchivedStateMigratePostUpdate({ paths: PATHS, env: DEVSWARM_ENV, cwd: fx.cwd, home: fx.home });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.scanned, 1);
    assert.strictEqual(r.migrated, 1);
    assert.match(r.detail, /scanned 1, migrated 1/);

    const state = JSON.parse(fs.readFileSync(path.join(fx.home, '.anti-hall', 'devswarm', 'auto-archived.json'), 'utf8'));
    assert.deepStrictEqual(state['ws-1'], [{ doneHead: 'h1', at: 1000 }]);

    // Never touches the ndjson log itself.
    const logAfter = fs.readFileSync(path.join(logsDir, 'devswarm-auto-archive.ndjson'), 'utf8');
    assert.match(logAfter, /"id":"ws-1"/);

    // Idempotent re-run.
    const again = autoArchivedStateMigratePostUpdate({ paths: PATHS, env: DEVSWARM_ENV, cwd: fx.cwd, home: fx.home });
    assert.strictEqual(again.migrated, 0, 're-run finds nothing new to migrate');
  } finally { fx.cleanup(); }
});

test('missing plugin files -> gracefully skips, never throws', () => {
  const fx = makeFixture();
  try {
    const r = autoArchivedStateMigratePostUpdate({ paths: { pluginSrcDir: path.join(fx.cwd, 'does-not-exist') }, env: DEVSWARM_ENV, cwd: fx.cwd, home: fx.home });
    assert.strictEqual(r.attempted, false);
    assert.match(r.detail, /expected plugin files not found/);
  } finally { fx.cleanup(); }
});
