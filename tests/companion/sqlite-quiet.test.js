'use strict';
// Regression: a long-lived companion under Monitor must not emit the node:sqlite
// ExperimentalWarning on stderr (each stderr line = one wake event = one model turn).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'sqlite-quiet.js');
const APP_DB = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-app-db.js');

function run(code) {
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
}

test('requireSqlite: loads node:sqlite with no ExperimentalWarning on stderr, other warnings still pass', () => {
  const r = run(
    'const s=require(' + JSON.stringify(HELPER) + ').requireSqlite();' +
    'if(typeof s.DatabaseSync!=="function")process.exit(3);' +
    'process.emitWarning("unrelated-warning");',
  );
  if (r.status === 3 || /Cannot find module 'node:sqlite'/.test(r.stderr)) return; // no node:sqlite on this Node
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/SQLite|ExperimentalWarning/.test(r.stderr), 'sqlite warning leaked: ' + r.stderr);
  assert.match(r.stderr, /unrelated-warning/, 'other warnings must still surface');
});

test('devswarm-app-db readSnapshot path (the wake-watch live-child check) is warning-free', () => {
  const r = run('require(' + JSON.stringify(APP_DB) + ').readSnapshot("/nonexistent/app.db", {env:{}});');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/ExperimentalWarning/.test(r.stderr), 'sqlite warning leaked: ' + r.stderr);
});
