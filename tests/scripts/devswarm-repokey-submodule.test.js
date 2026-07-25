'use strict';
// A1(a) regression (v0.66 review): repoKeyForWorktree()/gitCommonDir() from
// INSIDE a real git submodule used to derive repoKey from the literal string
// 'modules' (basename(dirname(`--git-common-dir`))), because git reports a
// submodule's common-dir as `<superproject>/.git/modules/<name>` — landing
// every submodule of every project on the SAME wrong 'modules-<hash>' bucket
// (a cross-project collision, not just a wrong name). This is a HERMETIC,
// NON-VACUOUS end-to-end test against a REAL git submodule (no injected io) —
// it fails on a revert of the devswarm-repokey.js fix (verified below).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function git(args, cwd) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout));
  }
  return r;
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

test('repoKeyForWorktree from INSIDE a real git submodule resolves to the SUPERPROJECT\'s repoKey, never the literal "modules-<hash>" bucket', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-submod-'));
  const superDir = path.join(root, 'super');
  const subSourceDir = path.join(root, 'subsource');
  fs.mkdirSync(superDir, { recursive: true });
  fs.mkdirSync(subSourceDir, { recursive: true });
  try {
    for (const dir of [superDir, subSourceDir]) {
      git(['init', '-q', dir]);
      git(['-C', dir, 'config', 'user.email', 'a@b.c']);
      git(['-C', dir, 'config', 'user.name', 'Test']);
      git(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init']);
    }
    // Local-path submodule add requires an explicit allow in modern git.
    git(['-C', superDir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSourceDir, 'sub']);
    git(['-C', superDir, 'commit', '-q', '-m', 'add submodule']);

    const subDir = path.join(superDir, 'sub');
    assert.ok(fs.existsSync(path.join(subDir, '.git')), 'submodule checkout must exist');

    const superKey = repokey.repoKeyForWorktree(superDir);
    const subKey = repokey.repoKeyForWorktree(subDir);

    assert.ok(superKey, 'superproject repoKey must resolve');
    assert.ok(subKey, 'submodule repoKey must resolve');
    // NON-VACUOUS core assertion: a reverted fix derives 'modules-<hash>' for
    // subKey (basename(dirname('<super>/.git/modules/sub'))==='modules'), which
    // is NEITHER 'super-...' nor equal to superKey — this assertion fails
    // against the pre-fix code.
    assert.ok(!subKey.startsWith('modules-'), 'must NEVER key off the literal "modules" segment, got ' + subKey);
    assert.equal(subKey, superKey, 'a submodule must key off its SUPERPROJECT\'s project identity, not its own on-disk .git/modules/<name> nesting');
    assert.ok(superKey.startsWith('super-'), 'sanity: superproject basename is the readable prefix, got ' + superKey);
  } finally {
    rm(root);
  }
});

test('repoKeyForWorktree from the superproject itself is UNCHANGED by the submodule probe (no submodule present, no false positive)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-nosubmod-'));
  try {
    git(['init', '-q', dir]);
    git(['-C', dir, 'config', 'user.email', 'a@b.c']);
    git(['-C', dir, 'config', 'user.name', 'Test']);
    git(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init']);
    const key = repokey.repoKeyForWorktree(dir);
    assert.ok(key, 'plain repo (no submodule) must still resolve a repoKey');
    assert.ok(!key.startsWith('modules-'), 'a plain repo must never be misread as a submodule');
  } finally {
    rm(dir);
  }
});
