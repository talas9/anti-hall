'use strict';
// The compact roster's unread column is DIRECT unread (the tick's definition);
// unseen broadcasts show separately as "(+N bcast)" only when non-zero.
// Isolated HOME throughout.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CLI_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
const { rosterUnreadCell, rosterHumanText } = require('../../plugins/anti-hall/scripts/devswarm-lib/roster-diag.js');

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-runread-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-runread-repo-'));
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  cp.spawnSync('git', ['-C', repo, 'add', '.']);
  cp.spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  const fx = { home, repo };
  fs.mkdirSync(path.join(home, 'inb'), { recursive: true });
  for (const [id, wt] of [['ws-live', repo], ['ws-peer', repo + '-peer']]) {
    fs.mkdirSync(wt, { recursive: true });
    const ib = path.join(home, 'inb', id + '.ndjson');
    run(fx, ['register', id, '--worktree', wt, '--session', 's-' + id, '--inbox', ib, '--cursor', ib + '.cursor']);
  }
  return { home, repo };
}
function run(fx, args) {
  const env = Object.assign({}, process.env, { HOME: fx.home, USERPROFILE: fx.home, ANTI_HALL_LOG_DIR: path.join(fx.home, 'logs'), PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) });
  delete env.ANTIHALL_ROSTER_HIDE_ARCHIVED;
  return cp.spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: fx.repo, env, encoding: 'utf8' }).stdout;
}

test('rosterUnreadCell: direct only; bcast suffix only when non-zero; unknown stays a dash', () => {
  assert.strictEqual(rosterUnreadCell({ directUnread: 0, broadcastUnread: 0 }), '0');
  assert.strictEqual(rosterUnreadCell({ directUnread: 2, broadcastUnread: 0 }), '2');
  assert.strictEqual(rosterUnreadCell({ directUnread: 0, broadcastUnread: 3 }), '0 (+3 bcast)');
  assert.strictEqual(rosterUnreadCell({ directUnread: null, broadcastUnread: 3 }), '—');
  const out = rosterHumanText({ workspaces: [{ id: 'ws-a', directUnread: 0, broadcastUnread: 0, hints: [] }] }, { now: 0 });
  assert.match(out, /\| ws-a \| active \| — \| 0 \| /);
});

test('roster unread equals the tick unread with broadcasts present; broadcast-only shows separately', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 3; i++) run(fx, ['send', '--broadcast', '--message', 'bcast ' + i]);
    // broadcast-only: tick says 0, roster says 0 plus the separate suffix
    const tick0 = run(fx, ['inbox', 'tick', 'ws-live', '--quiet']);
    assert.match(tick0, /unread 0,/, tick0);
    const json0 = JSON.parse(run(fx, ['roster', '--json']));
    const row0 = json0.workspaces.find((w) => w.id === 'ws-live');
    assert.strictEqual(row0.directUnread, 0);
    assert.ok(row0.broadcastUnread >= 3, JSON.stringify(row0));
    const text0 = run(fx, ['roster']);
    assert.match(text0, /ws-live[^\n]*\| 0 \(\+\d+ bcast\) \|/, text0);
    // two unread direct messages: tick and roster agree on 2
    for (let i = 0; i < 2; i++) run(fx, ['send', '--to', 'ws-live', '--message', 'direct ' + i]);
    const tick2 = run(fx, ['inbox', 'tick', 'ws-live', '--quiet']);
    const m = tick2.match(/unread (\d+),/);
    assert.ok(m, tick2);
    const row2 = JSON.parse(run(fx, ['roster', '--json'])).workspaces.find((w) => w.id === 'ws-live');
    assert.strictEqual(row2.directUnread, Number(m[1]));
    assert.match(run(fx, ['roster']), new RegExp('ws-live[^\\n]*\\| ' + m[1] + ' \\(\\+\\d+ bcast\\) \\|'));
  } finally { rm(fx.home); rm(fx.repo); }
});

test('compact width unchanged when there are no broadcasts', () => {
  const fx = fixture();
  try {
    const out = run(fx, ['roster']);
    assert.match(out, /ws-live[^\n]*\| 0 \|/, out);
    assert.ok(!/bcast/.test(out), out);
  } finally { rm(fx.home); rm(fx.repo); }
});
