'use strict';
// edit-guard / command-guard: the block message shown to a DevSwarm PRIMARY
// recommends spawning a child workspace only when hooks/lib/primary-tier.js says
// the tier text is on (ordinary repo). In a repo whose instructions forbid
// workspaces for real work, the workspace advice is dropped; the rest of the
// message and, above all, the block DECISION are unchanged (advice text only).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload, editPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const PRIMARY = Object.assign({ DEVSWARM_REPO_ID: 'repo-x' }, COORD);
const CHILD = Object.assign({ DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y' }, COORD);

function mkCwd(doctrine) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-gta-'));
  if (doctrine) fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# Rules\n- **NO WORKSPACES FOR REAL WORK.** Use subagents.\n');
  return d;
}
function run(hook, payload, env) {
  const h = makeHome();
  try { return testHook(hook, payload, { home: h.home, env }); } finally { h.cleanup(); }
}
const edit = (cwd, env, file) => run('edit-guard.js', editPayload('Edit', { filePath: file || 'src/app.js', cwd }), env);
const cmd = (cwd, env, command) => run('command-guard.js', Object.assign(bashPayload(command || 'npm run build'), { cwd }), env);
const WS = /CHILD WORKSPACE|devswarm\.js spawn|workspace-scale/;

test('edit-guard Primary, ordinary repo: workspace advice present', () => {
  const r = edit(mkCwd(false), PRIMARY);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.json.reason, WS);
});

test('edit-guard Primary, no-workspace repo: workspace advice dropped, subagent advice + hints kept', () => {
  const r = edit(mkCwd(true), PRIMARY);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(!WS.test(r.json.reason), r.json.reason);
  assert.match(r.json.reason, /primary\/main orchestrator does not touch files directly — spawn a subagent/);
  assert.match(r.json.reason, /skip edit-guard/);
  assert.match(r.json.reason, /\(tool: Edit\)$/);
});

test('edit-guard: devswarm.dispatchTierText off (env) drops the workspace advice too', () => {
  const r = edit(mkCwd(false), Object.assign({ ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT: '0' }, PRIMARY));
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(!WS.test(r.json.reason), r.json.reason);
});

test('edit-guard child wording is byte-identical in both repo kinds', () => {
  const a = edit(mkCwd(false), CHILD);
  const b = edit(mkCwd(true), CHILD);
  assert.strictEqual(a.status, 2);
  assert.strictEqual(a.json.reason, b.json.reason);
  assert.match(a.json.reason, /sub-orchestrator does not touch files directly in its workspace/);
});

test('command-guard Primary, ordinary repo: workspace advice present', () => {
  const r = cmd(mkCwd(false), PRIMARY);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.json.reason, WS);
});

test('command-guard Primary, no-workspace repo: workspace advice dropped, subagent advice + detection kept', () => {
  const r = cmd(mkCwd(true), PRIMARY);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(!WS.test(r.json.reason), r.json.reason);
  assert.match(r.json.reason, /DELEGATE to a subagent/);
  assert.match(r.json.reason, /\(verb: npm\)/);
  assert.match(r.json.reason, /Inline-allowed ONLY/);
});

test('command-guard child wording is byte-identical in both repo kinds', () => {
  const a = cmd(mkCwd(false), CHILD);
  const b = cmd(mkCwd(true), CHILD);
  assert.strictEqual(a.status, 2);
  assert.strictEqual(a.json.reason, b.json.reason);
});

test('NO LOOSENING: the allow/block decision is identical in an ordinary and a no-workspace repo', () => {
  const plain = mkCwd(false);
  const noWs = mkCwd(true);
  const cmds = ['npm run build', 'git status', 'ls', 'node --test tests/a.test.js | tail -5', 'docker compose up', 'echo hi'];
  for (const c of cmds) {
    const a = cmd(plain, PRIMARY, c);
    const b = cmd(noWs, PRIMARY, c);
    assert.strictEqual(a.status, b.status, c);
    assert.strictEqual(a.json && a.json.decision, b.json && b.json.decision, c);
  }
  for (const f of ['src/app.js', 'README.md', '.anti-hall/history/x.md', 'docs/a.md']) {
    const a = edit(plain, PRIMARY, f);
    const b = edit(noWs, PRIMARY, f);
    assert.strictEqual(a.status, b.status, f);
    assert.strictEqual(a.json && a.json.decision, b.json && b.json.decision, f);
  }
  // sanity: the matrix really contains both outcomes for each guard
  assert.strictEqual(cmd(plain, PRIMARY, 'npm run build').status, 2);
  assert.strictEqual(cmd(plain, PRIMARY, 'git status').status, 0);
  assert.strictEqual(edit(plain, PRIMARY, 'src/app.js').status, 2);
  assert.strictEqual(edit(plain, PRIMARY, '.anti-hall/history/x.md').status, 0);
});
