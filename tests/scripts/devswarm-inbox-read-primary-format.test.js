'use strict';
// peer request C (SkyCrew + tf3 Primaries, 2026-09-26):
//   - `inbox read-primary <id> --format text` -> one from/seq/body block per
//     message, plain text, instead of the raw JSON.
//   - `inbox read-primary <id> --ack-after-print` -> opt-in immediate ack
//     right after the read (the two-step read-then-`ack-primary --receipt`
//     default stays unchanged when the flag is absent).
// `inboxReadPrimaryTextLines`/`main`'s wiring is exercised at the CLI-argv
// layer (spawning the real script) for the --format text rendering, since
// that branch lives in main(), not in run(); `--ack-after-print` is
// exercised in-process via cli.run since it is a dispatch-layer behavior.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-fmt-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-fmt-repo-' + tag + '-'));
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

test('inbox read-primary --ack-after-print acks immediately; the two-step default (no flag) leaves the receipt un-applied', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ack-after-print');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const id = derivedId(repo);
    seedRegistry(home, repoKey, { id, worktreePath: repo, sessionId: 's-1' });
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { storeLib.appendMeshMessage(s, { from: 'peer', to: id, type: 'direct', message: 'm1', hash: 'h1', timestamp: Date.now() }); }
    finally { s.close(); }

    const c = ctx(home, { cwd: repo });

    // Default (no --ack-after-print): still unread after the read.
    const r1 = cli.run(['inbox', 'read-primary', id], c);
    assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
    assert.equal(r1.result.count, 1);
    assert.equal(r1.result.acked, false, 'two-step default: nothing acked yet');
    assert.equal(r1.result.autoAck, undefined, 'no auto-ack attempted without the flag');
    const stillUnread = cli.run(['inbox', 'peek-primary', id], c);
    assert.equal(stillUnread.result.count, 1, 're-reading unread mail after a plain read-primary must still show it (nothing acked)');

    // --ack-after-print: acks right away.
    const r2 = cli.run(['inbox', 'read-primary', id, '--ack-after-print'], c);
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result));
    assert.equal(r2.result.count, 1);
    assert.ok(r2.result.autoAck, 'autoAck must be reported when --ack-after-print is passed');
    assert.equal(r2.result.autoAck.ok, true, JSON.stringify(r2.result.autoAck));
    assert.equal(r2.result.autoAck.acked, true);

    const afterAck = cli.run(['inbox', 'peek-primary', id], c);
    assert.equal(afterAck.result.count, 0, 'after --ack-after-print the mail must be acked (no longer unread)');
  } finally { rm(home); rm(repo); }
});

test('inbox read-primary --format text prints one from/seq/body block per message (CLI stdout)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('format-text');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const id = derivedId(repo);
    seedRegistry(home, repoKey, { id, worktreePath: repo, sessionId: 's-2' });
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { storeLib.appendMeshMessage(s, { from: 'peer-2', to: id, type: 'direct', message: 'hello text format', hash: 'h2', timestamp: Date.now() }); }
    finally { s.close(); }

    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'inbox', 'read-primary', id, '--format', 'text'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /from: peer-2/);
    assert.match(res.stdout, /seq: \d+/);
    assert.match(res.stdout, /hello text format/);
    // Never the raw JSON envelope in text mode.
    assert.doesNotMatch(res.stdout, /"ok":true/);
  } finally { rm(home); rm(repo); }
});

test('inbox read-primary --format text with no unread mail renders a legible empty state, not a blank line', () => {
  const home = tmpHome();
  const repo = makeGitRepo('format-text-empty');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const id = derivedId(repo);
    seedRegistry(home, repoKey, { id, worktreePath: repo, sessionId: 's-3' });

    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'inbox', 'read-primary', id, '--format', 'text'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /no messages/);
  } finally { rm(home); rm(repo); }
});

test('inbox read-primary --format text --json forces the raw JSON back (explicit --json always wins)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('format-text-json-override');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const id = derivedId(repo);
    seedRegistry(home, repoKey, { id, worktreePath: repo, sessionId: 's-4' });

    const env = Object.assign({}, process.env, { HOME: home, ANTI_HALL_LOG_DIR: path.join(home, 'logs') });
    const res = cp.spawnSync(process.execPath, [CLI_PATH, 'inbox', 'read-primary', id, '--format', 'text', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
  } finally { rm(home); rm(repo); }
});
