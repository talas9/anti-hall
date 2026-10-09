'use strict';
// The devswarm stable launcher routes the ported mesh verbs (send, mesh read, mesh history, roster --ack, inbox ack-primary,
// heartbeat) to
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
  const h = run(['inbox', 'peek-primary', 'w1']);
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

test('on, engine exit 75 (deferred, nothing written): Node runs and the fallback is logged', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 75' });
  const r = run(['send', '--to', 'w']);
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /engine mesh send[\s\S]*node send/);
  assert.match(r.log, /exit 75/);
});

test('on, engine exit 70 (committed failure, it already wrote): passed through, Node is NEVER rerun', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 70' });
  const r = run(['send', '--to', 'w']);
  assert.strictEqual(r.code, 70);
  assert.doesNotMatch(r.trace, /^node /m);
});

test('on: inbox ack-primary is routed; the other inbox verbs stay in Node', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 0' });
  assert.strictEqual(run(['inbox', 'ack-primary', 'p1', '--receipt', 'r1']).code, 0);
  const r = run(['inbox', 'peek-primary', 'p1']);
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /engine mesh inbox ack-primary p1 --receipt r1\nnode inbox peek-primary p1/);
});

test('on: mesh history, roster (plain and --ack) and heartbeat are routed; the other verbs stay in Node', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 0' });
  assert.strictEqual(run(['mesh', 'history']).code, 0);
  assert.strictEqual(run(['roster', '--ack']).code, 0);
  assert.strictEqual(run(['roster', '--json', '--ack=1']).code, 0);
  assert.strictEqual(run(['heartbeat', 'w1', '--session', 's']).code, 0);
  assert.strictEqual(run(['roster']).code, 0);
  assert.strictEqual(run(['mesh', 'peek']).code, 3);
  const last = run(['inbox', 'peek-primary', 'w1']);
  assert.strictEqual(last.code, 3);
  assert.match(last.trace, /engine mesh mesh history\nengine mesh roster --ack\nengine mesh roster --json --ack=1\nengine mesh heartbeat w1 --session s\nengine mesh roster\nnode mesh peek stdin=\nnode inbox peek-primary w1 stdin=\n$/);
});

test('on: inbox read-primary is routed (the engine decides; a deferral runs Node)', () => {
  const ok = setup({ mode: 'on', engine: 'exit 0' });
  const r = ok.run(['inbox', 'read-primary', 'w1', '--format', 'text']);
  assert.strictEqual(r.code, 0);
  assert.match(r.trace, /engine mesh inbox read-primary w1 --format text\n$/);
  const d = setup({ mode: 'on', engine: 'exit 75' });
  const r2 = d.run(['inbox', 'read-primary', 'w1']);
  assert.strictEqual(r2.code, 3);
  assert.match(r2.trace, /engine mesh inbox read-primary w1[\s\S]*node inbox read-primary w1/);
});

test('on: help requests and the CLI verbs the engine answers (skip, archive-ignore, archive-unignore, gate-intent, notice, plan, scope, gate, workspaces, logs, wake-directive) are routed; a bare unknown verb stays in Node', () => {
  const { run } = setup({ mode: 'on', engine: 'exit 0' });
  for (const argv of [['help'], ['help', 'send', '--json'], ['-h'], ['--help'], ['--h'], ['inbox', 'x', '--help'], ['skip', 'edit-guard', '--ttl', '5'],
    ['archive-ignore', 'w1'], ['archive-unignore', 'w1'], ['gate-intent', '--reason', 'r'], ['notice', '--list'], ['plan', 'show', 'w1'],
    ['scope', 'add', 'w1', '--glob', 'a', '--note', 'n'], ['gate', 'w1', '--set', 'x'], ['workspaces', 'list'], ['logs', '--limit', '5'], ['wake-directive', 'w1'], ['ready-check', 'abc'], ['app-state', '--json'], ['app-sync', '--dry-run'], ['sync-ui', '--titles-json', 't.json'], ['supervision-report', '--days', '3'], ['nudge', 'w1'], ['archive-request', 'w1'], ['relay', '3', '--to', 'w1'], ['primary', 'status'], ['done', '--summary', 'x']]) {
    const r = run(argv);
    assert.strictEqual(r.code, 0, argv.join(' '));
    assert.ok(r.trace.endsWith('engine mesh ' + argv.join(' ') + '\n'), argv.join(' ') + ' -> ' + r.trace);
    assert.doesNotMatch(r.trace, /^node /m);
  }
  const u = run(['bogus-verb']);
  assert.strictEqual(u.code, 3);
  assert.doesNotMatch(u.trace, /engine mesh bogus-verb/);
  assert.match(u.trace, /node bogus-verb stdin=\n$/);
  const d = setup({ mode: 'on', engine: 'exit 75' }).run(['skip', 'g']);
  assert.strictEqual(d.code, 3);
  assert.match(d.trace, /engine mesh skip g\nnode skip g/);
});

test('on: inbox tick is routed; a deferral (exit 75) runs Node, a committed failure (exit 70) never reruns it', () => {
  const ok = setup({ mode: 'on', engine: 'exit 0' });
  assert.strictEqual(ok.run(['inbox', 'tick', 'w1', '--quiet']).code, 0);
  assert.match(ok.run(['inbox', 'tick', 'w1', '--quiet']).trace, /engine mesh inbox tick w1 --quiet/);
  const d = setup({ mode: 'on', engine: 'exit 75' });
  const r = d.run(['inbox', 'tick', 'w1', '--quiet']);
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /engine mesh inbox tick w1 --quiet\nnode inbox tick w1 --quiet/);
  const f = setup({ mode: 'on', engine: 'exit 70' });
  const r2 = f.run(['inbox', 'tick', 'w1', '--quiet']);
  assert.strictEqual(r2.code, 70);
  assert.doesNotMatch(r2.trace, /^node /m);
});

test('on, heartbeat deferred (exit 75): Node runs it; a committed failure (exit 70) is never rerun', () => {
  const d = setup({ mode: 'on', engine: 'exit 75' });
  const r = d.run(['heartbeat', 'w1', '--session', 's']);
  assert.strictEqual(r.code, 3);
  assert.match(r.trace, /engine mesh heartbeat w1 --session s\nnode heartbeat w1 --session s/);
  assert.match(r.log, /exit 75/);
  const f = setup({ mode: 'on', engine: 'exit 70' });
  const r2 = f.run(['heartbeat', 'w1', '--session', 's']);
  assert.strictEqual(r2.code, 70);
  assert.doesNotMatch(r2.trace, /^node /m);
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
