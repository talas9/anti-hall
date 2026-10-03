'use strict';
// upsertRegistry's id-collision guard must NOT refuse a same-worktree write whose
// worktreePath is a git SUBMODULE checkout inside the registered workspace
// (child-turn persists ctx.toplevel = the submodule path, while the id keys to
// the outermost superproject). A genuine collision (different worktree) must stay
// refused. Real `git submodule add` fixture under a tmp HOME.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const GIT_OK = (() => { try { return cp.spawnSync('git', ['--version']).status === 0; } catch (_) { return false; } })();

function mkFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-subreg-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const env = Object.assign({}, process.env, {
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  });
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  const git = (args, cwd) => {
    const r = cp.spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  };
  const mk = (d) => {
    fs.mkdirSync(d, { recursive: true });
    git(['init', '-q', '-b', 'main', d], d);
    fs.writeFileSync(path.join(d, 'f'), 'x');
    git(['add', '.'], d); git(['commit', '-q', '-m', 'i'], d);
    return d;
  };
  const origin = mk(path.join(root, 'origin'));
  const ws = mk(path.join(root, 'ws'));
  const other = mk(path.join(root, 'other'));
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', 'file://' + origin, 'skyfb'], ws);
  git(['commit', '-q', '-m', 'sub'], ws);
  return { root, home, ws, sub: path.join(ws, 'skyfb'), other };
}

const backends = ['journal'];
if (store.sqliteAvailable()) backends.push('sqlite');

for (const backend of backends) {
  test(`[${backend}] submodule path for a workspace-keyed id is the SAME worktree, not a collision`, { skip: !GIT_OK }, () => {
    const fx = mkFixture();
    const s = store.openStore({ home: fx.home, backend });
    try {
      const d = (p) => ({ id: 'f1a07335', worktreePath: p, sessionId: 's', inboxPath: '/i', cursorPath: '/c', nudgeCommand: ['x'] });
      assert.notStrictEqual(s.upsertRegistry(d(fx.ws)), false);
      // submodule subpath of the registered workspace: accepted (no-op path refresh)
      assert.notStrictEqual(s.upsertRegistry(d(fx.sub)), false, 'submodule subpath must not be refused');
      // reverse order (registered as submodule, refreshed from workspace root) also OK
      assert.notStrictEqual(s.upsertRegistry(d(fx.ws)), false);
      // genuine collision with a DIFFERENT worktree stays refused (safety net)
      assert.strictEqual(s.upsertRegistry(d(fx.other)), false, 'different worktree must still be refused');
      const row = s.listRegistry().find((r) => r.id === 'f1a07335');
      assert.ok(row && !/other$/.test(row.worktreePath), 'existing mapping preserved after genuine collision');
    } finally { s.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  });
}
