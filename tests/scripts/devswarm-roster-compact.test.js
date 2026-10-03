'use strict';
// Plain `roster` prints a compact table of LIVE workspaces + one `+N archived`
// line (follows the healthcheck/diagnose/app-state `--json` precedent). `--all`
// (or ANTIHALL_ROSTER_HIDE_ARCHIVED=0) lists archived rows too; `--json` prints
// the full object unchanged; `--ack` and the programmatic cli.run() API are
// untouched. The CLI is spawned with an isolated HOME (never the real one).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CLI_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
const cli = require(CLI_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rcompact-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// A project with ONE live registry row and `nArchived` archived descriptors.
function fixture(nArchived) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rcompact-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repo = makeGitRepo('c');
  const repoKey = repokey.repoKeyForWorktree(repo);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry({ id: 'ws-live', worktreePath: inst.resolveWorktree(repo), sessionId: 's' }); } finally { s.close(); }
  fs.mkdirSync(cli.archivedDir(home), { recursive: true });
  for (let i = 0; i < nArchived; i++) {
    const id = 'arch-' + String(i).padStart(4, '0') + '-aaaa-bbbb-cccc-dddddddddddd';
    fs.writeFileSync(path.join(cli.archivedDir(home), id + '.json'),
      JSON.stringify({ id, worktreePath: '/nonexistent/arch-' + i, sessionId: 's', ownerKey: repoKey }));
  }
  return { home, repo };
}

function spawnCli(fx, args, extraEnv) {
  // PATH is trimmed so a real `hivecontrol` on the machine never feeds roster's native fold.
  const env = Object.assign({}, process.env, { HOME: fx.home, USERPROFILE: fx.home, ANTI_HALL_LOG_DIR: path.join(fx.home, 'logs'), PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) });
  delete env.ANTIHALL_ROSTER_HIDE_ARCHIVED;
  const r = cp.spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: fx.repo, env: Object.assign(env, extraEnv || {}), encoding: 'utf8' });
  return r.stdout;
}

test('plain roster: live rows only + a `+N archived` count line, well under 4 KB with 150 archived', () => {
  const fx = fixture(150);
  try {
    const out = spawnCli(fx, ['roster']);
    assert.ok(out.includes('ws-live'), out);
    assert.ok(!out.includes('arch-0000'), 'archived rows are hidden');
    assert.match(out, /\+150 archived \(use --all to list them, --json for the full data\)/);
    assert.ok(Buffer.byteLength(out) < 4096, 'size ' + Buffer.byteLength(out));
    assert.throws(() => JSON.parse(out), 'plain output is not JSON');
  } finally { rm(fx.home); rm(fx.repo); }
});

test('roster --all lists archived rows; ANTIHALL_ROSTER_HIDE_ARCHIVED=0 does the same', () => {
  const fx = fixture(3);
  try {
    for (const out of [spawnCli(fx, ['roster', '--all']), spawnCli(fx, ['roster'], { ANTIHALL_ROSTER_HIDE_ARCHIVED: '0' })]) {
      assert.ok(out.includes('ws-live'));
      assert.ok(out.includes('arch-0000') && out.includes('arch-0002'), out);
      assert.ok(!/\+\d+ archived/.test(out), 'nothing hidden, so no count line');
    }
  } finally { rm(fx.home); rm(fx.repo); }
});

test('roster --json prints exactly the full JSON object cli.run returns', () => {
  const fx = fixture(2);
  try {
    const out = spawnCli(fx, ['roster', '--json']);
    const parsed = JSON.parse(out);
    const direct = cli.run(['roster'], { home: fx.home, backend: 'journal', env: {}, cwd: fx.repo, io: { run: () => ({ ok: false }) } }).result;
    assert.deepStrictEqual(Object.keys(parsed), Object.keys(direct));
    assert.strictEqual(parsed.count, 3);
    assert.strictEqual(parsed.archivedCount, 2);
    assert.deepStrictEqual(parsed.workspaces.map((w) => w.id), direct.workspaces.map((w) => w.id));
    // the programmatic API still returns the object (not text)
    assert.strictEqual(typeof direct, 'object');
  } finally { rm(fx.home); rm(fx.repo); }
});

test('roster --ack keeps its JSON behaviour (mesh-read alias)', () => {
  const fx = fixture(1);
  try {
    const out = spawnCli(fx, ['roster', '--ack', '--legacy-ack-now']);
    const parsed = JSON.parse(out);
    assert.ok('ok' in parsed);
  } finally { rm(fx.home); rm(fx.repo); }
});

test('a failed roster (no-project) still prints JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rcompact-np-'));
  try {
    const r = cp.spawnSync(process.execPath, [CLI_PATH, 'roster'], {
      cwd: dir, encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: dir, USERPROFILE: dir, ANTI_HALL_LOG_DIR: path.join(dir, 'logs') }),
    });
    assert.strictEqual(JSON.parse(r.stdout).reason, 'no-project');
  } finally { rm(dir); }
});
