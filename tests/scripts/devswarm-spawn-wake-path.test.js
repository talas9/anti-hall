'use strict';
// `devswarm.js spawn` from a Primary: when wake coverage is still incomplete
// after the spawn (no live watcher and/or no recent inbox tick), the result
// carries the NO MAILBOX ... instruction in `warnings`. Healthy coverage, a
// child caller and a non-Claude agent get no warning; existing keys unchanged.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnwake-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const installIngest = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const { resolveContext } = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));
const { lockPathFor } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js'));

const GIT_ENV = Object.assign({}, process.env, {
  HOME: LOG_DIR, USERPROFILE: LOG_DIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
});
function git(cwd, args) {
  const r = cp.spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnwake-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const primary = path.join(root, 'primary');
  cp.spawnSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV });
  fs.writeFileSync(path.join(primary, 'a.txt'), 'a');
  git(primary, ['add', '.']);
  git(primary, ['commit', '-q', '-m', 'a']);
  const id = installIngest.primaryWorkspaceId(resolveContext(primary, { home, missingPath: 'ancestor' }).worktreeRoot);
  return { root, home, primary, id };
}
const rm = (f) => { try { fs.rmSync(f.root, { recursive: true, force: true }); } catch (_) {} };

function fakeCreate(f) {
  return ({ args, cwd }) => {
    if (args[0] === 'workspace' && args[1] === 'create') {
      const child = args[2];
      const wt = path.join(f.root, 'wt-' + child.replace(/\W/g, '_'));
      const r = cp.spawnSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', child, wt, 'main'], { encoding: 'utf8', env: GIT_ENV });
      if (r.status !== 0) return { ok: false, error: r.stderr };
      return { ok: true, raw: JSON.stringify({ path: wt }), stderr: '' };
    }
    return { ok: true, raw: '{}' };
  };
}
function spawn(f, branch, env) {
  return cli.run(['spawn', branch], { home: f.home, backend: 'journal', env, cwd: f.primary, io: { run: fakeCreate(f) } }).result;
}
function writeLock(f) {
  const p = lockPathFor(f.home, f.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts: Date.now(), pid: process.pid }));
}
function writeTick(f, ageMin) {
  const dir = path.join(f.home, '.anti-hall', 'devswarm', 'wake-tick');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, f.id + '.json'), JSON.stringify({ ts: Date.now() - ageMin * 60000 }));
}
const CLAUDE = { DEVSWARM_AI_AGENT: 'claude' };

test('Primary spawn with no watcher and no tick -> warnings carries the full NO MAILBOX WAKE PATH instruction', () => {
  const f = fixture();
  try {
    const r = spawn(f, 'child-a', CLAUDE);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1, JSON.stringify(r.warnings));
    assert.ok(r.warnings[0].startsWith('NO MAILBOX WAKE PATH:'), r.warnings[0]);
    assert.ok(r.warnings[0].includes('inbox tick ' + f.id + ' --quiet'), r.warnings[0]);
    // Existing keys are untouched.
    assert.strictEqual(r.action, 'spawn');
    assert.strictEqual(r.created, true);
    assert.ok(r.timings && 'launched' in r);
  } finally { rm(f); }
});

test('only one path missing -> the shorter line for just that one', () => {
  const f = fixture();
  try {
    writeTick(f, 5);
    assert.ok(spawn(f, 'child-b', CLAUDE).warnings[0].startsWith('NO MAILBOX WATCHER'));
  } finally { rm(f); }
  const f2 = fixture();
  try {
    writeLock(f2);
    assert.ok(spawn(f2, 'child-c', CLAUDE).warnings[0].startsWith('NO MAILBOX TICK'));
  } finally { rm(f2); }
});

test('healthy coverage, a child caller, and a non-Claude agent -> no warnings key at all', () => {
  const f = fixture();
  try {
    writeLock(f); writeTick(f, 5);
    assert.strictEqual(spawn(f, 'child-d', CLAUDE).warnings, undefined);
  } finally { rm(f); }
  const f2 = fixture();
  try {
    assert.strictEqual(spawn(f2, 'child-e', Object.assign({ DEVSWARM_SOURCE_BRANCH: 'main' }, CLAUDE)).warnings, undefined, 'child caller');
    assert.strictEqual(spawn(f2, 'child-f', { DEVSWARM_AI_AGENT: 'codex' }).warnings, undefined, 'non-Claude');
  } finally { rm(f2); }
});
