'use strict';
// End to end: the real `roster` human output on a fixture store with direct
// unread 0 and broadcast unread 3 renders "0 (+3 bcast)" (the tick's direct
// unread, broadcasts shown separately). Isolated HOME; no real store.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CLI_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function run(fx, args) {
  const env = Object.assign({}, process.env, { HOME: fx.home, USERPROFILE: fx.home, ANTI_HALL_LOG_DIR: path.join(fx.home, 'logs'), PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) });
  delete env.ANTIHALL_ROSTER_HIDE_ARCHIVED;
  return cp.spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: fx.repo, env, encoding: 'utf8' }).stdout;
}

test('real roster human output: direct 0 + 3 broadcasts renders "0 (+3 bcast)"', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r-e2e-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r-e2e-repo-'));
  for (const a of [['init', '-q', repo], ['-C', repo, 'config', 'user.email', 'a@b.c'], ['-C', repo, 'config', 'user.name', 'T']]) cp.spawnSync('git', a);
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  cp.spawnSync('git', ['-C', repo, 'add', '.']);
  cp.spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const fx = { home, repo };
  try {
    fs.mkdirSync(path.join(home, 'inb'), { recursive: true });
    const ib = path.join(home, 'inb', 'ws-live.ndjson');
    run(fx, ['register', 'ws-live', '--worktree', repo, '--session', 's1', '--inbox', ib, '--cursor', ib + '.cursor']);
    for (let i = 0; i < 3; i++) run(fx, ['send', '--broadcast', '--message', 'b' + i]);
    const row = JSON.parse(run(fx, ['roster', '--json'])).workspaces.find((w) => w.id === 'ws-live');
    assert.strictEqual(row.directUnread, 0);
    assert.strictEqual(row.broadcastUnread, 3);
    const out = run(fx, ['roster']);
    assert.match(out, /ws-live[^\n]*\| 0 \(\+3 bcast\) \|/, out);
  } finally { rm(home); rm(repo); }
});
