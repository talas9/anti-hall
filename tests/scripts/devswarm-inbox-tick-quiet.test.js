'use strict';
// peer ask 2 (0.112 lane, DevSwarm Primary 0.110.0): `inbox tick`'s JSON
// carries duplicate legacy+new field names (unread/unreadTotal, cursor/
// cursorNdjson, storeCursor/cursorStore) which makes a cron-prompt directive
// pick over raw JSON error-prone. `inbox tick --quiet` prints ONE line —
// `tick <id>: unread N, known true|false, meshGap true|false, watcherArmed
// true|false` — on success, and a LOUD "ok:false ..." line + non-zero exit
// on failure. Same opt-in/--json-override precedence as `send --quiet` /
// `inbox read-primary --format text`. The JSON default (no --quiet) stays
// byte-identical — this is a strictly additive rendering.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

const CLI_PATH = require.resolve('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-tick-quiet-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-tick-quiet-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id) {
  const inboxPath = path.join(os.tmpdir(), 'never-inbox-' + id + '.jsonl');
  const cursorPath = path.join(os.tmpdir(), 'never-cursor-' + id + '.json');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', 's-' + id, '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
}

test('inboxTickQuietLine renders "tick <id>: unread N, known true|false, meshGap true|false, watcherArmed true|false" on success', () => {
  const line = cli.inboxTickQuietLine({ ok: true, id: 'w1', unreadTotal: 3, known: true, meshGapWithheld: false, watcherArmed: true });
  assert.equal(line, 'tick w1: unread 3, known true, meshGap false, watcherArmed true');
});

test('inboxTickQuietLine treats an absent meshGapWithheld as false (count omits it when 0)', () => {
  const line = cli.inboxTickQuietLine({ ok: true, id: 'w2', unreadTotal: 0, known: true, watcherArmed: false });
  assert.equal(line, 'tick w2: unread 0, known true, meshGap false, watcherArmed false');
});

test('inboxTickQuietLine renders a loud "ok:false ..." line on failure', () => {
  const line = cli.inboxTickQuietLine({ ok: false, error: 'unregistered-workspace' });
  assert.equal(line, 'ok:false unregistered-workspace');
});

test('inbox tick --quiet (CLI): one line, exit 0, no mail', () => {
  const home = tmpHome();
  const repo = makeGitRepo('quiet-ok');
  try {
    register(home, repo, 'w1');
    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'inbox', 'tick', 'w1', '--quiet'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout.trim(), /^tick w1: unread \d+, known (true|false), meshGap (true|false), watcherArmed (true|false)$/);
  } finally { rm(home); rm(repo); }
});

test('inbox tick --quiet --json forces the raw JSON back (explicit --json always wins)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('quiet-json');
  try {
    register(home, repo, 'w1');
    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'inbox', 'tick', 'w1', '--quiet', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, 'tick');
    // duplicate legacy+new names still both present in the JSON default:
    assert.ok('unread' in parsed && 'unreadTotal' in parsed, 'JSON default must keep both legacy+new unread fields');
  } finally { rm(home); rm(repo); }
});

test('inbox tick (no --quiet): unchanged raw JSON output', () => {
  const home = tmpHome();
  const repo = makeGitRepo('plain');
  try {
    register(home, repo, 'w1');
    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'inbox', 'tick', 'w1'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.action, 'tick');
  } finally { rm(home); rm(repo); }
});
