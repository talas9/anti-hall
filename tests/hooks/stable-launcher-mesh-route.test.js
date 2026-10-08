'use strict';
// The devswarm stable launcher routes the ported mesh verbs (send, mesh read) to
// `ah-engine mesh` when settings mesh.engine_writes = "on" and the engine exists.
// Scratch HOME, fake engine and fake Node target: never the real ~/.anti-hall.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sl = require('../../plugins/anti-hall/hooks/lib/stable-launcher.js');

function setup({ mode, engine, timeoutMs }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-meshroute-'));
  const ah = path.join(home, '.anti-hall');
  fs.mkdirSync(ah, { recursive: true });
  const trace = path.join(home, 'trace.log');
  const target = path.join(home, 'devswarm.js');
  fs.writeFileSync(target, `require('fs').appendFileSync(${JSON.stringify(trace)}, 'node ' + process.argv.slice(2).join(' ') + ' stdin=' + (process.argv.includes('--message-stdin') ? require('fs').readFileSync(0, 'utf8') : '') + '\\n'); process.exit(3);`);
  const settings = {};
  if (mode) settings.mesh = { engine_writes: mode };
  if (timeoutMs) (settings.mesh = settings.mesh || {}).engine_timeout_ms = timeoutMs;
  fs.writeFileSync(path.join(ah, 'settings.json'), JSON.stringify(settings));
  if (engine) {
    const bin = path.join(ah, 'ah-engine', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ah-engine'), `#!/bin/sh\necho "engine $*" >> ${JSON.stringify(trace)}\n${engine}\n`, { mode: 0o755 });
  }
  const launcher = path.join(home, 'launcher.js');
  fs.writeFileSync(launcher, sl.buildLauncherSource(['scripts', 'devswarm.js'], target));
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [launcher, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }, input, encoding: 'utf8',
    });
    let t = ''; try { t = fs.readFileSync(trace, 'utf8'); } catch (_) {}
    let log = ''; try { log = fs.readFileSync(path.join(ah, 'ah-engine', 'mesh-route.log'), 'utf8'); } catch (_) {}
    return { code: r.status, trace: t, log, out: r.stdout };
  };
  return { run, home };
}

test('switch off or unset: Node runs, the engine is never called', () => {
  for (const mode of [undefined, 'off', 'shadow']) {
    const { run } = setup({ mode, engine: 'exit 0' });
    const r = run(['send', '--to', 'w', '--message', 'hi']);
    assert.strictEqual(r.code, 3);
    assert.match(r.trace, /^node send --to w --message hi/);
    assert.doesNotMatch(r.trace, /engine/);
  }
});

test('on: send and mesh read go to ah-engine mesh with the same argv and its exit code', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 0' });
  assert.strictEqual(run(['send', '--to', 'w', '--message', 'hi']).code, 0);
  const r = run(['mesh', 'read', '--peek']);
  assert.strictEqual(r.code, 0);
  assert.match(r.trace, /engine mesh send --to w --message hi\nengine mesh mesh read --peek\n$/);
  assert.doesNotMatch(r.trace, /^node /m);
});

test('on: other verbs stay in Node; an engine native nonzero result is passed through', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 2' });
  const h = run(['heartbeat']);
  assert.strictEqual(h.code, 3);
  assert.doesNotMatch(h.trace, /engine/);
  assert.strictEqual(run(['send', '--to', 'w']).code, 2);
});

test('on, engine missing: Node runs', () => {
  const { run } = setup({ mode: 'on' });
  const r = run(['send', '--to', 'w']);
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /^node send/);
});

test('on, engine exit 127 (cannot reach Node CLI, nothing written): Node runs and the fallback is logged', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 127' });
  const r = run(['send', '--to', 'w']);
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /engine mesh send[\s\S]*node send/);
  assert.match(r.log, /exit 127/);
});

test('on, engine exit 75 (already wrote): passed through, Node is NEVER rerun', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 75' });
  const r = run(['send', '--to', 'w']);
  assert.strictEqual(r.code, 75);
  assert.doesNotMatch(r.trace, /^node /m);
});

test('on, engine hangs: killed at the time limit, then Node runs', () => {
  const { run } = setup({ mode: 'on', engine: 'exec sleep 30', timeoutMs: 700 });
  const t0 = Date.now();
  const r = run(['send', '--to', 'w']);
  assert.ok(Date.now() - t0 < 10000);
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /node send/);
  assert.match(r.log, /ETIMEDOUT/);
});

test('on, --message-stdin: the body reaches the engine and, on fallback, Node', () => {
  const { run } = setup({ mode: 'on', engine: 'cat >> "$(dirname "$0")/body"; exit 127' });
  const r = run(['send', '--to', 'w', '--message-stdin'], 'the body');
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /node send --to w --message-stdin stdin=the body/);
});

test('the wake-watch launcher is never routed', () => {
  const { home } = setup({ mode: 'on', engine: 'exit 0' });
  const trace = path.join(home, 'trace.log');
  const target = path.join(home, 'ww.js');
  fs.writeFileSync(target, 'process.exit(4)');
  const l = path.join(home, 'ww-launcher.js');
  fs.writeFileSync(l, sl.buildLauncherSource(['companion', 'lib', 'x.js'], target));
  const r = spawnSync(process.execPath, [l, 'send'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 4);
  assert.ok(!fs.existsSync(trace));
});
