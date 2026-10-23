'use strict';
// The plugin must work with no engine binary: the hook command (hooks.json, direct form) runs hooks/install.sh while the thin client
// is missing, and that fails open without running any Node hook. The cases use only the isolated HOME and a PATH
// without ah-engine. Also pins the shipped engine lock: when the plugin ships ah-engine.lock it
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
const HAS_SH = fs.existsSync('/bin/sh');

function scratch() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-engine-fallback-')));
}

// The command the host runs for `event`: the event's one handler in the shipped hooks.json (the direct form), run with `sh -c`.
function hookCommand(event) {
  const j = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  return j.hooks[event][0].hooks[0].command;
}

function runHook(event, payload, extraEnv) {
  const home = scratch();
  const env = {
    PATH: '/usr/bin:/bin', // no ah-engine on PATH, no thin client under HOME
    HOME: home,
    USERPROFILE: home,
    AH_ENGINE_BOOTSTRAP: '0',
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    ...extraEnv,
  };
  const r = spawnSync('sh', ['-c', hookCommand(event)], {
    input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 60000,
  });
  const installed = fs.existsSync(path.join(home, '.anti-hall', 'ah-engine', 'bin', 'ah-hook'));
  fs.rmSync(home, { recursive: true, force: true });
  return { ...r, installed };
}

// With no thin client the installer may say once that anti-hall is not installed; it must say nothing else, print nothing on stdout,
// start no Node hook and download nothing (the download is opt-in: AH_ENGINE_BOOTSTRAP=1 or the engine.bootstrap setting).
function assertFailsOpenQuietly(r) {
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '', 'a hook with no thin client prints nothing on stdout');
  assert.ok(r.stderr.split('\n').filter(Boolean).length <= 1, `at most one notice line: ${r.stderr}`);
  assert.strictEqual(r.installed, false, 'nothing is downloaded without the opt-in');
}

test('no thin client, guard event: the hook command fails open with at most one notice line', { skip: !HAS_SH }, () => {
  assertFailsOpenQuietly(runHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'fallback-test' }, {}));
});

test('no thin client, guard event, a harmless call: allowed without hand-over', { skip: !HAS_SH }, () => {
  assertFailsOpenQuietly(runHook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, session_id: 'fallback-test', cwd: os.tmpdir() }, {}));
});

test('no thin client, non-guard event: exits 0 and never blocks', { skip: !HAS_SH }, () => {
  assertFailsOpenQuietly(runHook('UserPromptSubmit', { prompt: 'hello', session_id: 'fallback-test', cwd: os.tmpdir() }, {}));
});

test('no thin client: the notice is said once per session', { skip: !HAS_SH }, () => {
  const home = scratch();
  const env = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, AH_ENGINE_BOOTSTRAP: '0', CLAUDE_PLUGIN_ROOT: PLUGIN };
  const run = () => spawnSync('sh', ['-c', hookCommand('Stop')], { input: JSON.stringify({ session_id: 'same-session' }), env, encoding: 'utf8', timeout: 60000 });
  const first = run();
  const second = run();
  fs.rmSync(home, { recursive: true, force: true });
  assert.strictEqual(first.stderr.split('\n').filter(Boolean).length, 1, first.stderr);
  assert.strictEqual(second.stderr, '', 'the same session is told once');
});

const TARGETS = [
  'aarch64-apple-darwin', 'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl',
];
const ROOT_LOCK = path.join(ROOT, 'ah-engine.lock');
const PLUGIN_LOCK = path.join(PLUGIN, 'ah-engine.lock');

test('shipped plugin ah-engine.lock byte-equals the root lock and lists all 6 targets (plus the source tarball)', { skip: !fs.existsSync(PLUGIN_LOCK) && 'no plugin lock shipped yet' }, () => {
  assert.ok(fs.existsSync(ROOT_LOCK), 'plugin lock present but root ah-engine.lock missing');
  assert.ok(fs.readFileSync(PLUGIN_LOCK).equals(fs.readFileSync(ROOT_LOCK)), 'plugin lock differs from root lock');
  const lock = JSON.parse(fs.readFileSync(PLUGIN_LOCK, 'utf8'));
  assert.strictEqual(lock.schema, 1);
  assert.strictEqual(lock.tag, `ah-engine-v${lock.version}`);
  // The release workflow's expected set: one archive per target plus the vendored source tarball.
  const expected = [...TARGETS.map((t) => `ah-engine-v${lock.version}-${t}.tar.gz`), `ah-engine-v${lock.version}-src.tar.gz`].sort();
  assert.deepStrictEqual(Object.keys(lock.assets).sort(), expected, 'lock assets differ from the 6 targets plus the source tarball');
  for (const [name, sha] of Object.entries(lock.assets)) assert.match(sha, /^[0-9a-f]{64}$/, name);
  const targetsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'ah-engine', 'targets.json'), 'utf8')).map((x) => x.triple).sort();
  assert.deepStrictEqual(targetsJson, [...TARGETS].sort(), 'targets.json drifted from this test');
});
