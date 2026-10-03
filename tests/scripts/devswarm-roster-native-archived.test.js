'use strict';
// roster: a hivecontrol "native" row (id = branch name) for a workspace whose
// archived/<uuid>.json descriptor exists must not read as live. The native id
// is a branch name, so the id-keyed archive predicates never match it; the
// roster joins it to the archived descriptor by worktreePath / meshId instead.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function seedArchived(home, repoKey, id, worktreePath) {
  fs.mkdirSync(cli.archivedDir(home), { recursive: true });
  fs.writeFileSync(path.join(cli.archivedDir(home), id + '.json'),
    JSON.stringify({ id, worktreePath, sessionId: 's', ownerKey: repoKey }));
}
const nativeIo = (children) => ({ run: (spec) => (spec.args[1] === 'list' && spec.args[2] === 'children'
  ? { ok: true, raw: JSON.stringify(children) } : { ok: true, raw: '{}' }) });

test('native row whose EXISTING worktree matches an archived descriptor is folded into the archived row', () => {
  const home = tmpHome();
  const repo = makeGitRepo('exists');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-wt-'));
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const uuid = '4b079c4d-1111-2222-3333-444455556666';
    seedArchived(home, repoKey, uuid, wt);
    // same dir, spelled with a trailing slash (a different raw string)
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io: nativeIo([{ branch: 'qa/ui-field-audit', path: wt + '/' }]) }));
    assert.equal(r.result.ok, true);
    const rows = r.result.workspaces.filter((w) => w.id === uuid || w.id === 'qa/ui-field-audit');
    assert.equal(rows.length, 1, 'one row, not two: ' + JSON.stringify(rows));
    assert.equal(rows[0].source, 'archived');
    assert.ok(rows[0].hints.includes('archived'));
    assert.equal(rows[0].worktreePath, wt + '/');
    assert.equal(r.result.liveCount, 0);
    assert.equal(r.result.archivedCount, 1);
    assert.equal(r.result.count, 1);
  } finally { rm(home); rm(repo); rm(wt); }
});

test('native row with a symlinked spelling of the archived worktree is still matched (realpath)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('symlink');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-wt-'));
  const link = wt + '-link';
  try {
    fs.symlinkSync(wt, link);
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedArchived(home, repoKey, 'arch-uuid-1', wt);
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io: nativeIo([{ branch: 'qa/x', path: link }]) }));
    const rows = r.result.workspaces.filter((w) => w.id === 'arch-uuid-1' || w.id === 'qa/x');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'archived');
  } finally { rm(home); rm(repo); rm(wt); rm(link); }
});

test('native row on a DIFFERENT worktree than any archived descriptor stays live', () => {
  const home = tmpHome();
  const repo = makeGitRepo('other');
  const wtA = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-wt-'));
  const wtB = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-wt-'));
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedArchived(home, repoKey, 'arch-uuid-2', wtA);
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io: nativeIo([{ branch: 'live/branch', path: wtB }]) }));
    const nat = r.result.workspaces.find((w) => w.id === 'live/branch');
    assert.ok(nat);
    assert.equal(nat.source, 'native');
    assert.ok(!nat.hints.includes('archived'));
    assert.equal(r.result.liveCount, 1);
    assert.equal(r.result.archivedCount, 1);
  } finally { rm(home); rm(repo); rm(wtA); rm(wtB); }
});

test('archived descriptor owned by ANOTHER project does not archive a native row here', () => {
  const home = tmpHome();
  const repo = makeGitRepo('foreign');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rna-wt-'));
  try {
    seedArchived(home, 'some-other-project-key', 'arch-uuid-3', wt);
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io: nativeIo([{ branch: 'qa/y', path: wt }]) }));
    const nat = r.result.workspaces.find((w) => w.id === 'qa/y');
    assert.ok(nat);
    assert.equal(nat.source, 'native');
    assert.ok(!nat.hints.includes('archived'));
  } finally { rm(home); rm(repo); rm(wt); }
});
