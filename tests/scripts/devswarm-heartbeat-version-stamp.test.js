'use strict';
// devswarm.js — item 4a (P0, field-proven): a child session auto-resumed
// BEFORE the harness re-registered a newer anti-hall build keeps running the
// OLD code — 0.105.3 (NDJSON-only) cannot see store-side mesh mail, so the
// Primary saw it as "not draining" when the real cause was a stale build.
// Both write paths that touch heartbeats/<id>.json (`heartbeat` and
// `inbox tick`) now stamp the CALLING process's own running anti-hall
// version (runningAntiHallVersion(), resolved from THIS file's own
// .claude-plugin/plugin.json via __dirname) onto every record, so a reader
// (item 4b) can tell "stale build" apart from "genuinely wedged".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const PLUGIN_ROOT = path.join(__dirname, '../../plugins/anti-hall');
const REAL_VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-hb-version-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});
function heartbeatPath(home, id) { return path.join(home, '.anti-hall', 'devswarm', 'heartbeats', id + '.json'); }

test('runningAntiHallVersion(): resolves THIS repo\'s own plugin.json version', () => {
  assert.strictEqual(cli.runningAntiHallVersion(), REAL_VERSION);
  assert.match(cli.runningAntiHallVersion(), /^\d+\.\d+\.\d+$/);
});

test('cmdHeartbeat: `heartbeat <id>` stamps `version` onto the written record', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['heartbeat', 'w1'], ctx(home));
    assert.strictEqual(r.result.ok !== false, true, JSON.stringify(r.result));
    const beat = JSON.parse(fs.readFileSync(heartbeatPath(home, 'w1'), 'utf8'));
    assert.strictEqual(beat.version, REAL_VERSION);
  } finally { rm(home); }
});

test('inbox tick: creating a fresh heartbeat file stamps `version`', () => {
  const home = tmpHome();
  try {
    // No prior heartbeat file for this id — tick's own "beat" is null,
    // hitting the minimal-creation branch.
    cli.run(['inbox', 'tick', 'w2'], ctx(home));
    const beat = JSON.parse(fs.readFileSync(heartbeatPath(home, 'w2'), 'utf8'));
    assert.strictEqual(beat.version, REAL_VERSION);
  } finally { rm(home); }
});

test('inbox tick: refreshing an EXISTING heartbeat re-stamps `version` on every tick, not only creation', () => {
  const home = tmpHome();
  try {
    cli.run(['heartbeat', 'w3'], ctx(home));
    // Simulate a heartbeat written by an OLDER build (no version field at
    // all — the pre-fix shape) to prove the refresh path backfills it, not
    // just preserves whatever was already there.
    const p = heartbeatPath(home, 'w3');
    const before = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete before.version;
    fs.writeFileSync(p, JSON.stringify(before));

    cli.run(['inbox', 'tick', 'w3'], ctx(home));
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(after.version, REAL_VERSION, 'a stale/missing version field must be re-stamped on every tick');
  } finally { rm(home); }
});

test('cmdHeartbeat: version is stamped regardless of --session / other caller flags (not caller-authored)', () => {
  const home = tmpHome();
  try {
    cli.run(['heartbeat', 'w4', '--session', 'sess-w4', '--progress', '50'], ctx(home));
    const beat = JSON.parse(fs.readFileSync(heartbeatPath(home, 'w4'), 'utf8'));
    assert.strictEqual(beat.version, REAL_VERSION);
    assert.strictEqual(beat.sessionId, 'sess-w4');
  } finally { rm(home); }
});
