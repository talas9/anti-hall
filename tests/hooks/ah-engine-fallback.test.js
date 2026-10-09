'use strict';
// The plugin must work with no engine binary: ah-hook.sh falls back to the Node hooks (non-guard events) and fails
// closed on guard events (list overrides need AH_WRAPPER_TEST=1; the other cases use only the isolated HOME and a PATH
// without ah-engine) it cannot answer. Also pins the shipped engine lock: when the plugin ships ah-engine.lock it
// must byte-equal the root lock and list every release target. Every spawn runs in an isolated temp HOME.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'anti-hall');
const WRAPPER = path.join(PLUGIN, 'hooks', 'ah-hook.sh');
const HAS_SH = fs.existsSync('/bin/sh');

function scratch() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-engine-fallback-')));
}

function runWrapper(event, payload, extraEnv, args = []) {
  const home = scratch();
  const env = {
    PATH: '/usr/bin:/bin', // no ah-engine on PATH
    HOME: home,
    USERPROFILE: home,
    AH_ENGINE_BOOTSTRAP: '0',
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    ...extraEnv,
  };
  const r = spawnSync('sh', [WRAPPER, event, ...args], {
    input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 60000,
  });
  fs.rmSync(home, { recursive: true, force: true });
  return r;
}

test('no engine, guard event, no usable fallback list: fails closed (exit 2)', { skip: !HAS_SH }, () => {
  const dir = scratch();
  const missing = path.join(dir, 'absent.list');
  const r = runWrapper('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } },
    { AH_WRAPPER_TEST: '1', AH_ENGINE_BIN: '/no/such/engine', AH_FALLBACK_LIST: missing }, ['--tool-from-payload']);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /fail closed for PreToolUse/);
});

test('no engine, guard event, real Node fallback: a harmless call is allowed', { skip: !HAS_SH }, () => {
  const r = runWrapper('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, session_id: 'fallback-test', cwd: os.tmpdir() },
    {}, ['--tool-from-payload']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /engine fallback/);
});

test('no engine, non-guard event: the Node fallback hooks run', { skip: !HAS_SH }, () => {
  const dir = scratch();
  const sentinel = path.join(dir, 'ran');
  const hook = path.join(dir, 'hook.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\nprintf ran > '${sentinel}'\n`, { mode: 0o755 });
  const list = path.join(dir, 'x.list');
  fs.writeFileSync(list, `@UserPromptSubmit\t10\n*\t10\tsh ${hook}\n`);
  const r = runWrapper('UserPromptSubmit', { prompt: 'hi', session_id: 'fallback-test' }, { AH_WRAPPER_TEST: '1', AH_ENGINE_BIN: '/no/such/engine', AH_FALLBACK_LIST: list });
  const ran = fs.existsSync(sentinel);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(ran, 'the fallback hook did not run');
});

test('no engine, non-guard event, real Node fallback: exits 0 and never blocks', { skip: !HAS_SH }, () => {
  const r = runWrapper('UserPromptSubmit', { prompt: 'hello', session_id: 'fallback-test', cwd: os.tmpdir() }, {});
  assert.strictEqual(r.status, 0, r.stderr);
});

const TARGETS = [
  'aarch64-apple-darwin', 'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl',
];
const ROOT_LOCK = path.join(ROOT, 'ah-engine.lock');
const PLUGIN_LOCK = path.join(PLUGIN, 'ah-engine.lock');

test('shipped plugin ah-engine.lock byte-equals the root lock and lists all 6 targets', { skip: !fs.existsSync(PLUGIN_LOCK) && 'no plugin lock shipped yet' }, () => {
  assert.ok(fs.existsSync(ROOT_LOCK), 'plugin lock present but root ah-engine.lock missing');
  assert.ok(fs.readFileSync(PLUGIN_LOCK).equals(fs.readFileSync(ROOT_LOCK)), 'plugin lock differs from root lock');
  const lock = JSON.parse(fs.readFileSync(PLUGIN_LOCK, 'utf8'));
  assert.strictEqual(lock.schema, 1);
  assert.strictEqual(lock.tag, `ah-engine-v${lock.version}`);
  const names = Object.keys(lock.assets);
  for (const t of TARGETS) {
    const hit = names.filter((n) => n.includes(`-${t}.`));
    assert.strictEqual(hit.length, 1, `lock must list exactly one asset for ${t}`);
    assert.match(lock.assets[hit[0]], /^[0-9a-f]{64}$/);
  }
  assert.strictEqual(names.length, TARGETS.length, 'lock lists assets beyond the 6 targets');
  const targetsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'ah-engine', 'targets.json'), 'utf8')).map((x) => x.triple).sort();
  assert.deepStrictEqual(targetsJson, [...TARGETS].sort(), 'targets.json drifted from this test');
});
