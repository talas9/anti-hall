'use strict';
// A Primary running devswarm verbs from a SUBMODULE cwd must resolve the SAME
// Primary id as from the worktree root. Before the fix, register-primary /
// `workspaces list` / archive-prefix resolution used `git --show-toplevel`
// (the submodule's own toplevel; its `.git` is a FILE) and minted a phantom
// `primary-<submodule-hash>` id. Real submodule fixture, tmp HOME, subprocess CLI.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const CLI = path.join(PLUGIN, 'scripts', 'devswarm.js');
const identity = require(path.join(PLUGIN, 'companion', 'lib', 'identity.js'));

let tmp, home, proj, sub;
const GIT = ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@t'];
function git(cwd, args) {
  const r = spawnSync('git', GIT.concat(args), { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
}
function cli(cwd, args) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' });
  delete env.DEVSWARM_BUILDER_ID;
  const r = spawnSync(process.execPath, [CLI].concat(args), { cwd, env, encoding: 'utf8', timeout: 60000 });
  const line = String(r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'))[0] || '{}';
  return JSON.parse(line);
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-subcwd-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const lib = path.join(tmp, 'lib');
  proj = path.join(tmp, 'proj');
  fs.mkdirSync(lib); fs.mkdirSync(proj);
  git(lib, ['init', '-q']); fs.writeFileSync(path.join(lib, 'a'), 'a'); git(lib, ['add', 'a']); git(lib, ['commit', '-qm', 'i']);
  git(proj, ['init', '-q']); fs.writeFileSync(path.join(proj, 'a'), 'a'); git(proj, ['add', 'a']); git(proj, ['commit', '-qm', 'i']);
  git(proj, ['submodule', 'add', '-q', lib, 'skyflutter']); git(proj, ['commit', '-qm', 's']);
  sub = path.join(proj, 'skyflutter');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

test('fixture: the submodule .git is a file and its toplevel differs from the worktree root', () => {
  assert.ok(fs.statSync(path.join(sub, '.git')).isFile());
  assert.notStrictEqual(identity.resolveContext(sub).toplevel, identity.resolveContext(proj).toplevel);
  assert.strictEqual(identity.resolveContext(sub).worktreeRoot, identity.resolveContext(proj).worktreeRoot);
});

test('register-primary from the submodule cwd registers the ROOT primary id (no phantom)', () => {
  const rootId = identity.resolveContext(proj).meshId;
  const fromSub = cli(sub, ['register-primary', '--session', 's1']);
  assert.strictEqual(fromSub.ok, true, JSON.stringify(fromSub));
  assert.strictEqual(fromSub.id, rootId);
  assert.strictEqual(fs.realpathSync(fromSub.worktree), proj);
  const fromRoot = cli(proj, ['register-primary', '--session', 's1']);
  assert.strictEqual(fromRoot.id, rootId);
  const list = cli(sub, ['workspaces', 'list']);
  assert.strictEqual(list.workspaceId, rootId);
  const ids = (list.workspaces || []).map((w) => w.id).filter((i) => /^primary-/.test(i));
  assert.deepStrictEqual(ids, [rootId], 'exactly one primary row, no phantom: ' + ids);
});

test('inbox read-primary from the submodule cwd equals the one from the root', () => {
  const rootId = identity.resolveContext(proj).meshId;
  const strip = (r) => { const o = Object.assign({}, r); delete o.cwd; delete o.readReceiptId; delete o.ackCommand; return o; };
  const a = cli(proj, ['inbox', 'read-primary', rootId]);
  const b = cli(sub, ['inbox', 'read-primary', rootId]);
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.strictEqual(b.ok, true, JSON.stringify(b));
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(b.repoKey, a.repoKey);
  assert.deepStrictEqual(strip(b).meshPartitionIds, strip(a).meshPartitionIds);
});
