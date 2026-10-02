'use strict';
// devswarm.js split, stage 2: the `core` module (scripts/devswarm-lib/core.js).
// Pins (1) the dispatcher's export surface (names) against a snapshot taken
// before any code moved out of it, (2) core's own contract: CLI_PATH names the
// real dispatcher, core never requires the dispatcher, the size cap, and the
// ONE home of the module-level heartbeat temp counter.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const source = require('./lib/devswarm-source.js');

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts');
const DISPATCHER = path.join(SCRIPTS, 'devswarm.js');
const CORE_PATH = path.join(SCRIPTS, 'devswarm-lib', 'core.js');
const SNAPSHOT = path.join(__dirname, '..', 'fixtures', 'devswarm-split', 'exports.snapshot.json');

test('devswarm.js export surface is identical to the pre-split snapshot', () => {
  const cli = require(DISPATCHER);
  const want = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  assert.deepStrictEqual(Object.keys(cli).sort(), want);
  assert.deepStrictEqual(want, want.slice().sort(), 'snapshot is sorted');
});

test('core.CLI_PATH is the real dispatcher script and PLUGIN_ROOT the plugin root', () => {
  const core = require(CORE_PATH);
  assert.strictEqual(core.CLI_PATH, DISPATCHER);
  assert.ok(fs.statSync(core.CLI_PATH).isFile());
  assert.strictEqual(core.PLUGIN_ROOT, path.join(SCRIPTS, '..'));
  assert.ok(fs.existsSync(path.join(core.PLUGIN_ROOT, '.claude-plugin', 'plugin.json')));
});

test('core.runningAntiHallVersion resolves the real plugin.json (path depth fixed)', () => {
  const core = require(CORE_PATH);
  const want = JSON.parse(fs.readFileSync(path.join(core.PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.strictEqual(core.runningAntiHallVersion(), want);
  assert.strictEqual(require(DISPATCHER).runningAntiHallVersion, core.runningAntiHallVersion);
});

test('every devswarm-lib module: no load-time require of the dispatcher, relative requires are ../../ or ./, size cap', () => {
  const dir = path.dirname(CORE_PATH);
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.js'));
  assert.ok(files.includes('core.js'));
  for (const n of files) {
    const text = fs.readFileSync(path.join(dir, n), 'utf8');
    // A call-time require of the dispatcher (indented, inside a function) is allowed in core ONLY.
    assert.ok(!/^[^\s/][^\n]*require\(\s*['"][^'"]*devswarm\.js['"]\s*\)/m.test(text), n + ': load-time require of devswarm.js');
    if (n !== 'core.js') assert.ok(!/require\(\s*['"][^'"]*\/devswarm\.js['"]\s*\)/.test(text), n + ': only core.js may call-time-require the dispatcher');
    assert.ok(!/require\(\s*['"]\.\.\/(?!\.\.\/|devswarm\.js)/.test(text), n + ': a one-level ../ require would resolve inside devswarm-lib/');
    assert.ok(fs.statSync(path.join(dir, n)).size <= 262144, n + ' exceeds 256 KiB');
  }
});

test('heartbeat temp counter has ONE home: core owns the let, everyone else calls nextHeartbeatTmp()', () => {
  const core = require(CORE_PATH);
  const a = core.nextHeartbeatTmp();
  assert.strictEqual(core.nextHeartbeatTmp(), a + 1);
  const decls = source.readEach().filter((e) => /\blet\s+heartbeatTmpCounter\b/.test(e.text));
  assert.deepStrictEqual(decls.map((e) => e.file), [CORE_PATH]);
  const dispatcher = fs.readFileSync(DISPATCHER, 'utf8');
  assert.ok(!/heartbeatTmpCounter/.test(dispatcher), 'the dispatcher must not touch the counter directly');
});

test('monkeypatching cli.deriveReaderNonce still reaches moved callers (they go through the DISPATCHER export object)', () => {
  const cli = require(DISPATCHER);
  const readerCursors = require(path.join(SCRIPTS, '..', 'companion', 'lib', 'reader-cursors.js'));
  const orig = cli.deriveReaderNonce;
  const PINNED = 'h:4242:1700000000000';
  try {
    cli.deriveReaderNonce = () => PINNED;
    const want = readerCursors.readerKey(PINNED);
    assert.ok(want, 'the pinned nonce is a valid reader key');
    assert.strictEqual(cli.callerReaderKey({}), want);
    cli.deriveReaderNonce = () => null;
    assert.strictEqual(cli.callerReaderKey({}), readerCursors.readerKey(null));
  } finally { cli.deriveReaderNonce = orig; }
  assert.strictEqual(cli.deriveReaderNonce, orig);
});

test('lib modules never read module.exports.X (that is the dispatcher export object, reached via dispatcherExports())', () => {
  const dir = path.dirname(CORE_PATH);
  for (const n of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, n), 'utf8');
    assert.ok(!/module\.exports\.[A-Za-z_]/.test(text), n + ': module.exports.X would hit this module, not the dispatcher');
  }
});

test('core.cliRun is the dispatcher run() and core.dispatcherExports() is the dispatcher export object', () => {
  const core = require(CORE_PATH);
  const cli = require(DISPATCHER);
  assert.strictEqual(core.dispatcherExports(), cli);
  const a = core.cliRun(['help', '--short'], { home: require('node:os').tmpdir(), env: {} });
  const b = cli.run(['help', '--short'], { home: require('node:os').tmpdir(), env: {} });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.code, 0);
});
