'use strict';
// L18 (3): a main-thread Write to <repo>/.anti-hall/progress/<date>/<session>.md
// (the file tasklist-guard demands, named under the project ROOT) must pass no
// matter which cwd the payload carries: repo root, a subdirectory the shell
// cd'd into, or a symlinked spelling of the repo. DEFAULT_ALLOW '.anti-hall/**'
// was matched only against the path relative to the payload cwd, so any cwd
// other than the root made the path read '../.anti-hall/...' and was blocked.
// Dangerous forms must stay blocked (fail closed).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egstate-repo-')));
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.mkdirSync(path.join(dir, 'packages', 'foo'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'x\n');
  return dir;
}

function write(home, filePath, cwd) {
  return testHook('edit-guard.js', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'x' },
    session_id: 't',
    cwd,
  }, { home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
}

const REL = path.join('.anti-hall', 'progress', '2026-10-01', 'sess.md');

test('progress file under repo root is allowed from the root cwd (baseline)', () => {
  const repo = makeRepo(); const h = makeHome();
  try { assert.strictEqual(write(h.home, path.join(repo, REL), repo).status, 0); }
  finally { h.cleanup && h.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('progress file under repo root is allowed when the payload cwd is a subdirectory', () => {
  const repo = makeRepo(); const h = makeHome();
  try { assert.strictEqual(write(h.home, path.join(repo, REL), path.join(repo, 'packages', 'foo')).status, 0); }
  finally { h.cleanup && h.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('progress file is allowed when cwd is a symlinked spelling of the repo', () => {
  const repo = makeRepo(); const h = makeHome();
  const link = repo + '-link';
  try {
    fs.symlinkSync(repo, link);
    assert.strictEqual(write(h.home, path.join(repo, REL), link).status, 0);
    assert.strictEqual(write(h.home, path.join(link, REL), repo).status, 0);
  } finally { fs.rmSync(link, { force: true }); h.cleanup && h.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('fail closed: source files, other repos and lookalike dirs stay blocked from a subdirectory cwd', () => {
  const repo = makeRepo(); const other = makeRepo(); const h = makeHome();
  const sub = path.join(repo, 'packages', 'foo');
  try {
    assert.strictEqual(write(h.home, path.join(repo, 'src', 'x.js'), sub).status, 2);
    assert.strictEqual(write(h.home, path.join(repo, 'src', '.anti-hall', 'x.md'), sub).status, 2);
    assert.strictEqual(write(h.home, path.join(repo, 'x.anti-hall', 'p.md'), sub).status, 2);
    assert.strictEqual(write(h.home, path.join(other, REL), sub).status, 2);
  } finally { h.cleanup && h.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('fail closed: a symlinked .anti-hall directory cannot smuggle a source write from a subdirectory cwd', () => {
  const repo = makeRepo(); const h = makeHome();
  try {
    fs.symlinkSync(path.join(repo, 'src'), path.join(repo, '.anti-hall'));
    assert.strictEqual(write(h.home, path.join(repo, '.anti-hall', 'x.js'), path.join(repo, 'packages', 'foo')).status, 2);
  } finally { h.cleanup && h.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
});

// L24: a main-thread Write to <repo>/.anti-hall/handovers/<date>/<sid>/HANDOVER.md
// (the handover skill's target) must pass for a plain coordinator, a DevSwarm
// Primary and a DevSwarm child, from every cwd spelling, even when the
// <date>/<sid> (or the whole handovers) dir does not exist yet. Reported on
// 0.118.0, where any cwd other than the repo root blocked it.
const HREL = path.join('.anti-hall', 'handovers', '2026-10-01', 'sid', 'HANDOVER.md');
const ENVS = {
  plain: {},
  primary: { DEVSWARM_REPO_ID: 'repo-x' },
  child: { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y' },
};
function writeEnv(home, filePath, cwd, env) {
  return testHook('edit-guard.js', {
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'x' }, session_id: 't', cwd,
  }, { home, env: Object.assign({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, env) });
}

for (const [role, env] of Object.entries(ENVS)) {
  for (const exists of [false, true]) {
    test(`handover doc allowed (${role}, dirs ${exists ? 'exist' : 'missing'}): abs/rel/subdir/symlink cwd`, () => {
      const repo = makeRepo(); const h = makeHome(); const link = repo + '-link';
      try {
        if (exists) fs.mkdirSync(path.dirname(path.join(repo, HREL)), { recursive: true });
        fs.symlinkSync(repo, link);
        const abs = path.join(repo, HREL);
        assert.strictEqual(writeEnv(h.home, abs, repo, env).status, 0, 'abs, root cwd');
        assert.strictEqual(writeEnv(h.home, HREL, repo, env).status, 0, 'relative');
        assert.strictEqual(writeEnv(h.home, abs, path.join(repo, 'packages', 'foo'), env).status, 0, 'subdir cwd');
        assert.strictEqual(writeEnv(h.home, abs, link, env).status, 0, 'symlinked cwd');
        assert.strictEqual(writeEnv(h.home, path.join(link, HREL), repo, env).status, 0, 'symlinked path');
      } finally { fs.rmSync(link, { force: true }); h.cleanup && h.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); }
    });
  }
}

test('fail closed: handover lookalike root, traversal and another repo stay blocked (Primary, subdir cwd)', () => {
  const repo = makeRepo(); const other = makeRepo(); const h = makeHome();
  const sub = path.join(repo, 'packages', 'foo');
  const env = ENVS.primary;
  try {
    assert.strictEqual(writeEnv(h.home, path.join(repo, '.anti-hall-x', 'handovers', 'HANDOVER.md'), sub, env).status, 2, 'lookalike root dir');
    assert.strictEqual(writeEnv(h.home, path.join(repo, '.anti-hall', 'handovers', '..', '..', 'src', 'x.js'), sub, env).status, 2, 'traversal');
    assert.strictEqual(writeEnv(h.home, path.join(other, HREL), sub, env).status, 2, 'other repo');
  } finally { h.cleanup && h.cleanup(); fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});
