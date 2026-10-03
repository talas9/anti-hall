'use strict';
// peer request D (SkyCrew + tf3 Primaries, 2026-09-26): `send --quiet` prints
// one line ("sent seq N -> X, B bytes, ok") instead of the full JSON, and
// prints a LOUD "ok:false ..." line + keeps the non-zero exit code on
// failure. The rendering lives in main() (an alternate stdout format, same
// as healthcheck/diagnose's human-line mode), so it is exercised by
// spawning the real CLI; `sendQuietLine` itself also gets direct unit
// coverage since it is exported.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const CLI_PATH = require.resolve('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-quiet-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-quiet-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function derivedId(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}

test('sendQuietLine renders "sent seq N -> X, B bytes, ok" on success', () => {
  const line = cli.sendQuietLine({ ok: true, seq: 7, to: 'sibling-id', type: 'direct', bytes: 12 });
  assert.equal(line, 'sent seq 7 -> sibling-id, 12 bytes, ok');
});

test('sendQuietLine renders "sent seq N -> (broadcast), B bytes, ok" for a broadcast', () => {
  const line = cli.sendQuietLine({ ok: true, seq: 3, to: null, type: 'broadcast', bytes: 5 });
  assert.equal(line, 'sent seq 3 -> (broadcast), 5 bytes, ok');
});

test('sendQuietLine renders a loud "ok:false ..." line on failure', () => {
  const line = cli.sendQuietLine({ ok: false, error: 'send --to "x" is not a registered mesh workspace' });
  assert.equal(line, 'ok:false send --to "x" is not a registered mesh workspace');
});

test('send --quiet (CLI): one success line, exit 0', () => {
  const home = tmpHome();
  const repo = makeGitRepo('quiet-ok');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const senderId = derivedId(repo);
    const targetId = 'quiet-target';
    seedRegistry(home, repoKey, { id: senderId, worktreePath: repo, sessionId: 's-1' });
    seedRegistry(home, repoKey, { id: targetId, worktreePath: path.join(os.tmpdir(), 'never-exists-quiet-target'), sessionId: 's-2' });

    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'send', '--to', targetId, '--message', 'hi', '--quiet'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout.trim(), /^sent seq \d+ -> quiet-target, 2 bytes, ok$/);
  } finally { rm(home); rm(repo); }
});

test('send --quiet (CLI): a failed send prints a loud ok:false line and exits non-zero', () => {
  const home = tmpHome();
  const repo = makeGitRepo('quiet-fail');
  try {
    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'send', '--to', 'nobody-registered', '--message', 'hi', '--quiet'], { cwd: repo, env, encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout.trim(), /^ok:false /);
  } finally { rm(home); rm(repo); }
});

test('send --quiet --json forces the raw JSON back (explicit --json always wins)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('quiet-json');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const senderId = derivedId(repo);
    const targetId = 'quiet-json-target';
    seedRegistry(home, repoKey, { id: senderId, worktreePath: repo, sessionId: 's-1' });
    seedRegistry(home, repoKey, { id: targetId, worktreePath: path.join(os.tmpdir(), 'never-exists-quiet-json-target'), sessionId: 's-2' });

    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'send', '--to', targetId, '--message', 'hi', '--quiet', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
  } finally { rm(home); rm(repo); }
});
