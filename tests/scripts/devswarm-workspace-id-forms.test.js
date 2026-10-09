'use strict';
// Field defect: a workspace has two id forms (meshId `primary-<hash>`, the label
// `spawn` returns, and the app/builder uuid its descriptor is keyed by). Verbs
// split: `archive <meshId>` resolved, `unarchive <meshId>` did not (archived-only
// descriptor + tombstoned registry row), `send --to <uuid>` hit
// unregistered-recipient. One canonical join now serves all of them.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-idforms-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const UUID = 'c661e0ec-1111-4222-8333-444455556666';
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-idforms-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
function makeRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-idforms-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'R'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'i']);
  return dir;
}
function addWt(main, tag) {
  const wt = path.join(path.dirname(main), path.basename(main) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', main, 'worktree', 'add', wt, '-b', 'b-' + tag]);
  return wt;
}
const ctx = (home, cwd) => ({ home, backend: 'journal', env: {}, cwd });
const meshOf = (dir) => inst.primaryWorkspaceId(inst.resolveWorktree(dir));

test('unarchive accepts the meshId, a uuid prefix and the full uuid of an archived workspace', () => {
  for (const form of ['mesh', 'prefix', 'full']) {
    const home = tmpHome();
    const main = makeRepo('u-' + form);
    const wt = addWt(main, 'c');
    try {
      assert.equal(cli.run(['register', UUID, '--worktree', wt, '--session', 's'], ctx(home, main)).result.ok, true);
      const a = cli.run(['archive', UUID], ctx(home, main));
      assert.equal(a.result.ok, true, JSON.stringify(a.result));
      assert.ok(fs.existsSync(path.join(cli.archivedDir(home), UUID + '.json')));
      const arg = form === 'mesh' ? meshOf(wt) : form === 'prefix' ? UUID.slice(0, 8) : UUID;
      const u = cli.run(['unarchive', arg], ctx(home, main));
      assert.equal(u.result.ok, true, form + ': ' + JSON.stringify(u.result));
      assert.equal(u.result.id, UUID);
      assert.ok(fs.existsSync(cli.descriptorPath(home, UUID)), 'descriptor restored');
    } finally { rm(home); rm(main); rm(wt); }
  }
});

test('archive then unarchive both resolve the meshId of a registered workspace (no id-form split)', () => {
  const home = tmpHome();
  const main = makeRepo('sym');
  const wt = addWt(main, 'c');
  try {
    cli.run(['register', UUID, '--worktree', wt, '--session', 's'], ctx(home, main));
    const a = cli.run(['archive', meshOf(wt)], ctx(home, main));
    assert.equal(a.result.ok, true, JSON.stringify(a.result));
    assert.equal(a.result.id, UUID);
    const u = cli.run(['unarchive', meshOf(wt)], ctx(home, main));
    assert.equal(u.result.ok, true, JSON.stringify(u.result));
  } finally { rm(home); rm(main); rm(wt); }
});

test('send --to <uuid> reaches the meshId-keyed (spawn phantom) row; an unknown/archived id gets an actionable error', () => {
  const home = tmpHome();
  const main = makeRepo('send');
  const wt = addWt(main, 'c');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const mesh = meshOf(wt);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.upsertRegistry({ id: mesh, worktreePath: wt, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null }); } finally { s.close(); }
    // the app-side uuid descriptor (no registry row of its own)
    fs.mkdirSync(path.dirname(cli.descriptorPath(home, UUID)), { recursive: true });
    fs.writeFileSync(cli.descriptorPath(home, UUID), JSON.stringify({ id: UUID, worktreePath: wt, sessionId: null }));
    const byMesh = cli.run(['send', '--to', mesh, '--message', 'hi'], ctx(home, main));
    assert.equal(byMesh.result.ok, true, JSON.stringify(byMesh.result));
    const byUuid = cli.run(['send', '--to', UUID, '--message', 'hi'], ctx(home, main));
    assert.equal(byUuid.result.ok, true, JSON.stringify(byUuid.result));
    assert.equal(byUuid.result.toId, mesh, 'uuid routes to the same partition as the meshId');

    // archived-only uuid, no registry row: error names the fix
    const arch = '99999999-aaaa-4bbb-8ccc-dddd00001111';
    fs.mkdirSync(cli.archivedDir(home), { recursive: true });
    fs.writeFileSync(path.join(cli.archivedDir(home), arch + '.json'), JSON.stringify({ id: arch, worktreePath: path.join(os.tmpdir(), 'gone-wt') }));
    const bad = cli.run(['send', '--to', arch, '--message', 'hi'], ctx(home, main));
    assert.equal(bad.result.ok, false);
    assert.equal(bad.result.reason, 'unregistered-recipient');
    assert.match(bad.result.error, /ARCHIVED.*unarchive/);
  } finally { rm(home); rm(main); rm(wt); }
});

test('sibling verbs (gate, plan, scope, nudge, wake-directive, archive-ignore, inbox count) resolve meshId + uuid prefix to the one canonical id', () => {
  const home = tmpHome();
  const main = makeRepo('sib');
  const wt = addWt(main, 'c');
  try {
    cli.run(['register', UUID, '--worktree', wt, '--session', 's'], ctx(home, main));
    const mesh = meshOf(wt);
    const calls = {
      gate: (x) => ['gate', x, '--set', 'done'],
      plan: (x) => ['plan', 'show', x],
      scope: (x) => ['scope', 'add', x, '--glob', 'a/**', '--note', 'n'],
      nudge: (x) => ['nudge', x],
      'wake-directive': (x) => ['wake-directive', x],
      'archive-ignore': (x) => ['archive-ignore', x],
      'inbox-count': (x) => ['inbox', 'count', x],
    };
    for (const [verb, mk] of Object.entries(calls)) {
      for (const form of [mesh, UUID.slice(0, 8)]) {
        const r = cli.run(mk(form), ctx(home, main)).result;
        const echoed = verb === 'nudge' ? r.resolvedId : r.id;
        assert.equal(echoed, UUID, verb + ' ' + form + ': ' + JSON.stringify(r));
      }
    }
    // nothing was written under the alias keys
    assert.equal(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'archive-ignore', mesh + '.json')), false);
  } finally { rm(home); rm(main); rm(wt); }
});
