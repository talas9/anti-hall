'use strict';
// L17: mesh read / inbox messages row-shape normalization, mesh read --last /
// --since filters, and send / heartbeat / mesh read resolving the project from
// the declared DevSwarm workspace (DEVSWARM_BUILDER_ID descriptor) when the cwd
// is not a git worktree. In-process via cli.run with a tmp HOME + journal backend.

const fs0 = require('node:fs'), os0 = require('node:os'), path0 = require('node:path');
process.env.ANTI_HALL_LOG_DIR = fs0.mkdtempSync(path0.join(os0.tmpdir(), 'anti-hall-l17-log-'));

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

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-l17-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-l17-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
function seedDescriptor(home, id, worktreePath) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, worktreePath, sessionId: 's' }));
}

test('mesh read broadcasts carry normalized from/text/kind and keep legacy from/message', () => {
  const home = tmpHome();
  const repo = makeGitRepo('norm');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: inst.primaryWorkspaceId(repo), worktreePath: repo, sessionId: 's' });
    cli.run(['send', '--broadcast', '--message', 'hello all'], ctx(home, { cwd: repo }));
    const r = cli.run(['mesh', 'read', '--peek'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    const b = r.result.broadcasts[0];
    assert.equal(b.text, 'hello all');
    assert.equal(b.message, 'hello all', 'legacy key kept');
    assert.equal(b.kind, 'broadcast');
    assert.equal(typeof b.from, 'string');
  } finally { rm(home); rm(repo); }
});

test('inbox messages direct rows carry normalized from/text/kind and keep legacy sender/body', () => {
  const home = tmpHome();
  const main = makeGitRepo('direct');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    seedRegistry(home, repoKey, { id: 'peer-1', worktreePath: path.join(home, 'nowhere'), sessionId: 's' });
    const sent = cli.run(['send', '--to', 'peer-1', '--message', 'direct text'], ctx(home, { cwd: main }));
    assert.equal(sent.result.ok, true, JSON.stringify(sent.result));
    const r = cli.run(['inbox', 'messages', 'peer-1'], ctx(home, { cwd: main }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    const m = r.result.messages[0];
    assert.equal(m.body, 'direct text');
    assert.equal(m.text, 'direct text');
    assert.equal(m.kind, 'direct');
    assert.equal(m.from, m.sender);
    assert.ok(m.from);
  } finally { rm(home); rm(main); }
});

test('mesh read --last N and --since are peek-only', () => {
  const home = tmpHome();
  const repo = makeGitRepo('filters');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: inst.primaryWorkspaceId(repo), worktreePath: repo, sessionId: 's' });
    for (const t of ['one', 'two', 'three']) cli.run(['send', '--broadcast', '--message', t], ctx(home, { cwd: repo }));
    const last = cli.run(['mesh', 'read', '--peek', '--last', '2'], ctx(home, { cwd: repo }));
    assert.deepEqual(last.result.broadcasts.map((b) => b.text), ['two', 'three']);
    assert.equal(last.result.filteredOut, 1);
    assert.equal(last.result.acked, false);

    const future = cli.run(['mesh', 'read', '--peek', '--since', new Date(Date.now() + 3600e3).toISOString()], ctx(home, { cwd: repo }));
    assert.equal(future.result.count, 0);
    const recent = cli.run(['mesh', 'read', '--peek', '--since', '1h'], ctx(home, { cwd: repo }));
    assert.equal(recent.result.count, 3);

    const bad = cli.run(['mesh', 'read', '--peek', '--since', 'garbage'], ctx(home, { cwd: repo }));
    assert.equal(bad.result.ok, false);
    assert.equal(bad.result.reason, 'bad-since');
    const badLast = cli.run(['mesh', 'read', '--peek', '--last', '0'], ctx(home, { cwd: repo }));
    assert.equal(badLast.result.reason, 'bad-last');

    // non-peek + filter is refused and consumes nothing.
    for (const extra of [['--last', '1'], ['--since', '1h']]) {
      const np = cli.run(['mesh', 'read'].concat(extra), ctx(home, { cwd: repo }));
      assert.equal(np.result.ok, false);
      assert.equal(np.result.reason, 'filter-requires-peek');
      assert.match(np.result.hint, /use --peek, then a plain `mesh read` to consume/);
    }
    const still = cli.run(['mesh', 'read', '--peek'], ctx(home, { cwd: repo }));
    assert.equal(still.result.count, 3, 'refused filtered read must not ack');
    assert.equal(cli.run(['mesh', 'read'], ctx(home, { cwd: repo })).result.count, 3);
  } finally { rm(home); rm(repo); }
});

test('send / heartbeat --summary / mesh read resolve the project from DEVSWARM_BUILDER_ID when cwd is not a worktree', () => {
  const home = tmpHome();
  const repo = makeGitRepo('envcwd');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const self = inst.primaryWorkspaceId(repo);
    seedRegistry(home, repoKey, { id: self, worktreePath: repo, sessionId: 's' });
    seedRegistry(home, repoKey, { id: 'peer-1', worktreePath: path.join(home, 'nowhere'), sessionId: 's' });
    seedDescriptor(home, 'builder-x', repo);
    const nonGit = path.join(home, 'scratch');
    fs.mkdirSync(nonGit, { recursive: true });
    const env = { DEVSWARM_BUILDER_ID: 'builder-x' };

    const s = cli.run(['send', '--to', 'peer-1', '--message', 'from scratch'], ctx(home, { cwd: nonGit, env }));
    assert.equal(s.result.ok, true, JSON.stringify(s.result));
    const b = cli.run(['send', '--broadcast', '--message', 'bcast from scratch'], ctx(home, { cwd: nonGit, env }));
    assert.equal(b.result.ok, true, JSON.stringify(b.result));
    const hb = cli.run(['heartbeat', 'builder-x', '--summary', 'working'], ctx(home, { cwd: nonGit, env }));
    assert.notEqual(hb.result.meshBroadcast && hb.result.meshBroadcast.reason, 'no-project', JSON.stringify(hb.result.meshBroadcast));
    const m = cli.run(['mesh', 'read', '--peek'], ctx(home, { cwd: nonGit, env }));
    assert.equal(m.result.ok, true, JSON.stringify(m.result));
    assert.ok(m.result.broadcasts.some((x) => x.text === 'bcast from scratch'));

    // fail-closed: no env, or an env id with no descriptor, still no-project
    const n1 = cli.run(['send', '--broadcast', '--message', 'x'], ctx(home, { cwd: nonGit, env: {} }));
    assert.equal(n1.result.reason, 'no-project');
    const n2 = cli.run(['send', '--broadcast', '--message', 'x'], ctx(home, { cwd: nonGit, env: { DEVSWARM_BUILDER_ID: 'unknown-id' } }));
    assert.equal(n2.result.reason, 'no-project');
  } finally { rm(home); rm(repo); }
});
