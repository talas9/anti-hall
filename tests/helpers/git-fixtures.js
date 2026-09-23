'use strict';
// tests/helpers/git-fixtures.js — real-git identity fixture builder (mesh
// redesign Phase 2 / B0). Builds every location shape companion/lib/identity.js
// must classify, with REAL git in a tmp dir, so tests compare the spawn-free
// resolver against git's own answer rather than against hand-written literals.
//
// Why not tests/harness/scenarios.js buildSubmoduleLinkedWorktreeFixture: it
// builds only main + submodule + linked worktree. This builder is a superset
// (nested, non-absorbed, embedded, untracked nested repo, symlinked cwd,
// deleted path, non-git) — the harness builder stays as-is for its scenario.
//
// Isolation: every git spawn gets an isolated HOME, GIT_CONFIG_GLOBAL=/dev/null,
// GIT_CONFIG_NOSYSTEM=1 and has every GIT_* location var removed, so neither the
// developer's config nor an inherited GIT_DIR can change the layout.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const SCRUB = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX'];

function gitEnv(home) {
  const env = Object.assign({}, process.env);
  for (const k of SCRUB) delete env[k];
  return Object.assign(env, {
    HOME: home, USERPROFILE: home,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@anti-hall.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@anti-hall.test',
  });
}

// buildIdentityFixtures() -> { root, home, env, cwds: {name -> path}, expectKind: {name -> kind}, git(args,cwd), cleanup() }
function buildIdentityFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-idfx-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = gitEnv(home);
  function git(args, cwd) {
    const r = cp.spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + r.stderr);
    return r;
  }
  function repo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main', dir], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), path.basename(dir));
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'init'], dir);
    return dir;
  }
  const FILE_OK = ['-c', 'protocol.file.allow=always'];

  const inner = repo(path.join(root, 'inner'));
  const sub = repo(path.join(root, 'sub'));
  git([...FILE_OK, 'submodule', 'add', '-q', 'file://' + inner, 'inner'], sub);
  git(['commit', '-q', '-m', 'add inner'], sub);
  const sub2 = repo(path.join(root, 'sub2'));

  const main = repo(path.join(root, 'main'));
  git([...FILE_OK, 'submodule', 'add', '-q', 'file://' + sub, 'libs/sub'], main);
  git([...FILE_OK, 'submodule', 'update', '-q', '--init', '--recursive'], main);
  git(['commit', '-q', '-m', 'add libs/sub'], main);

  // Linked worktree BEFORE the gitlink-without-.gitmodules (emb) exists, so
  // `submodule update` inside it has a url for every gitlink it sees.
  const wt = path.join(root, 'wt');
  git(['worktree', 'add', '-q', wt, '-b', 'wtb'], main);
  git([...FILE_OK, 'submodule', 'update', '-q', '--init', '--recursive'], wt);

  // Non-absorbed submodule: a plain clone (own .git DIR) then `submodule add`
  // of the existing repo ("Adding existing repo at 'vend/raw'").
  git([...FILE_OK, 'clone', '-q', 'file://' + sub2, path.join(main, 'vend', 'raw')], main);
  git([...FILE_OK, 'submodule', 'add', '-q', 'file://' + sub2, 'vend/raw'], main);
  // Embedded gitlink repo (no .gitmodules entry).
  repo(path.join(main, 'emb'));
  git(['-c', 'advice.addEmbeddedRepo=false', 'add', 'emb'], main);
  git(['commit', '-q', '-m', 'add vend/raw + emb'], main);
  // Untracked nested repo.
  repo(path.join(main, 'untracked'));
  // Linked worktree OF a submodule (gitdir <main>/.git/modules/libs/sub/worktrees/subwt),
  // outside the superproject's tree: git reports no superproject for it; the decided
  // rule still keys it to the outermost superproject (main).
  const subwt = path.join(root, 'subwt');
  git(['worktree', 'add', '-q', subwt, '-b', 'subwtb'], path.join(main, 'libs', 'sub'));

  fs.mkdirSync(path.join(main, 'src', 'deep'), { recursive: true });
  fs.symlinkSync(main, path.join(root, 'mainlink'), 'dir');
  fs.mkdirSync(path.join(root, 'nongit', 'x'), { recursive: true });

  const cwds = {
    'main': main,
    'main/src/deep': path.join(main, 'src', 'deep'),
    'mainlink/src': path.join(root, 'mainlink', 'src'),
    'wt': wt,
    'main/untracked': path.join(main, 'untracked'),
    'main/libs/sub': path.join(main, 'libs', 'sub'),
    'main/libs/sub/inner': path.join(main, 'libs', 'sub', 'inner'),
    'wt/libs/sub': path.join(wt, 'libs', 'sub'),
    'wt/libs/sub/inner': path.join(wt, 'libs', 'sub', 'inner'),
    'main/vend/raw': path.join(main, 'vend', 'raw'),
    'main/emb': path.join(main, 'emb'),
    'subwt': subwt,
    'nongit/x': path.join(root, 'nongit', 'x'),
    'main/src/gone': path.join(main, 'src', 'gone'),
    'gone': path.join(root, 'gone'),
  };
  const expectKind = {
    'main': 'main', 'main/src/deep': 'main', 'mainlink/src': 'main', 'wt': 'linked-worktree',
    'main/untracked': 'main',
    'main/libs/sub': 'submodule-in-main', 'main/libs/sub/inner': 'submodule-in-main',
    'wt/libs/sub': 'submodule-in-linked-worktree', 'wt/libs/sub/inner': 'submodule-in-linked-worktree',
    'main/vend/raw': 'submodule-in-main', 'main/emb': 'submodule-in-main',
    'subwt': 'submodule-in-main',
    'nongit/x': 'non-git', 'main/src/gone': 'deleted', 'gone': 'deleted',
  };

  function cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  return { root, home, env, main, wt, subwt, cwds, expectKind, git, cleanup };
}

module.exports = { buildIdentityFixtures, gitEnv };
