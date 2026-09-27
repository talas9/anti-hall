'use strict';
// Meeseeks supervision P1 — plan tracking. Pins: numbered-step parsing, the
// plan file `spawn` writes from a numbered -p (never refusing a brief without
// one), `plan set` / `heartbeat --step` idempotence, the finish label, and the
// ADDITIVE contract — a workspace without a plan renders exactly as before
// (roster row shape, table normalizer, child-turn output). Isolated HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plan-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const planLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-plan.js'));
const inbox = require(path.join(ROOT, 'hooks', 'devswarm-parent-inbox.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));

const GIT_ENV = Object.assign({}, process.env, {
  HOME: LOG_DIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
});
function git(cwd, args) {
  const r = cp.spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plan-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ENV = { ANTIHALL_DEVSWARM_APP_DB: 'off', ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0', ANTIHALL_DEVSWARM_SPAWN_FROM_ORIGIN: '0' };

test('parseSteps: first 1..N numbered list, common forms, needs two items', () => {
  assert.deepStrictEqual(planLib.parseSteps('Do it:\n1. read the code\n2) write the fix\n3: test it\n'), ['read the code', 'write the fix', 'test it']);
  assert.deepStrictEqual(planLib.parseSteps('Step 1: a\nStep 2: b'), ['a', 'b']);
  assert.deepStrictEqual(planLib.parseSteps('- 1. a\n- 2. b'), ['a', 'b']);
  assert.deepStrictEqual(planLib.parseSteps('1. only one step'), [], 'a single item is not a plan');
  assert.deepStrictEqual(planLib.parseSteps('no list here'), []);
  assert.deepStrictEqual(planLib.parseSteps(''), []);
  assert.deepStrictEqual(planLib.parseSteps(null), []);
  // A lone "1." before the real list restarts it; a second full list after the first is ignored.
  assert.deepStrictEqual(planLib.parseSteps('1. intro\nctx\n1. a\n2. b\n1. x\n2. y'), ['a', 'b']);
  // Out-of-order numbers never join the list.
  assert.deepStrictEqual(planLib.parseSteps('1. a\n3. c\n2. b'), ['a', 'b']);
  assert.deepStrictEqual(planLib.parseScope('brief\nScope: plugins/**, tests/*.js\n'), ['plugins/**', 'tests/*.js']);
  assert.deepStrictEqual(planLib.parseScope('no scope line'), []);
});

test('finishLabel: "step 3/7 · 42m · progress 18m ago", blocked, all-done, no-progress', () => {
  const now = 10 * 3600000;
  const plan = planLib.newPlan({ key: 'k', id: 'k', steps: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], now: now - 5 * 3600000 });
  assert.strictEqual(planLib.finishLabel(plan, now), 'step 1/7 · 5h · no progress yet');
  planLib.applyStep(plan, 1, 'done', now - 90 * 60000);
  planLib.applyStep(plan, 2, 'done', now - 60 * 60000);
  planLib.applyStep(plan, 3, 'doing', now - 42 * 60000);
  plan.step_ts = now - 18 * 60000;
  assert.strictEqual(planLib.finishLabel(plan, now), 'step 3/7 · 42m · progress 18m ago');
  planLib.applyStep(plan, 3, 'blocked', now - 60000);
  assert.strictEqual(planLib.finishLabel(plan, now), 'step 3/7 blocked · 42m · progress 1m ago');
  for (let n = 3; n <= 7; n++) planLib.applyStep(plan, n, 'done', now);
  assert.strictEqual(planLib.finishLabel(plan, now), 'steps 7/7 done · progress 0m ago');
  assert.strictEqual(planLib.finishLabel(null, now), null);
});

test('plan set is idempotent; heartbeat --step records progress idempotently; bad input is refused', () => {
  const home = tmpHome();
  try {
    const c = { home, env: ENV, cwd: os.tmpdir(), now: 1000 };
    const steps = '1. read\n2. fix\n3. test';
    const a = cli.run(['plan', 'set', 'child-a', '--steps', steps, '--scope', 'src/**,tests/**'], c);
    assert.strictEqual(a.code, 0, JSON.stringify(a.result));
    assert.strictEqual(a.result.created, true);
    assert.deepStrictEqual(a.result.scope, ['src/**', 'tests/**']);
    const b = cli.run(['plan', 'set', 'child-a', '--steps', steps, '--scope', 'src/**,tests/**'], Object.assign({}, c, { now: 2000 }));
    assert.strictEqual(b.result.changed, false, 'an identical plan set is a no-op');
    const raw1 = fs.readFileSync(planLib.planPath(home, 'child-a'), 'utf8');

    const h1 = cli.run(['heartbeat', 'child-a', '--step', '2', '--status', 'doing'], Object.assign({}, c, { now: 3000 }));
    assert.strictEqual(h1.code, 0, JSON.stringify(h1.result));
    assert.strictEqual(h1.result.plan.changed, true);
    const h2 = cli.run(['heartbeat', 'child-a', '--step', '2', '--status', 'doing'], Object.assign({}, c, { now: 4000 }));
    assert.strictEqual(h2.result.plan.changed, false, 're-reporting the same status is a no-op');
    const plan = planLib.findPlan(home, { id: 'child-a' }).plan;
    assert.strictEqual(plan.step_ts, 3000, 'the no-op heartbeat did not move step_ts');
    assert.strictEqual(plan.steps[1].status, 'doing');
    assert.notStrictEqual(fs.readFileSync(planLib.planPath(home, 'child-a'), 'utf8'), raw1);

    const bad = cli.run(['heartbeat', 'child-a', '--step', '9'], c);
    assert.strictEqual(bad.code, 2, 'a step outside the plan is a caller mistake');
    assert.strictEqual(bad.result.plan.reason, 'bad-step');
    const badStatus = cli.run(['heartbeat', 'child-a', '--step', '1', '--status', 'finished'], c);
    assert.strictEqual(badStatus.code, 2);

    const none = cli.run(['heartbeat', 'child-b', '--step', '1'], c);
    assert.strictEqual(none.code, 0, 'no plan is benign — the base heartbeat still counts');
    assert.strictEqual(none.result.plan.reason, 'no-plan');

    const plain = cli.run(['heartbeat', 'child-b'], c);
    assert.ok(!('plan' in plain.result), 'a heartbeat without --step or a plan keeps its old result shape');

    const noList = cli.run(['plan', 'set', 'child-c', '--steps', 'just prose'], c);
    assert.strictEqual(noList.code, 2);
    const show = cli.run(['plan', 'show', 'child-a'], Object.assign({}, c, { now: 3000 + 18 * 60000 }));
    assert.strictEqual(show.result.label, 'step 2/3 · 18m · progress 18m ago');
  } finally { rm(home); }
});

function spawnFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plan-spawn-')));
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const repo = path.join(root, 'repo');
  cp.spawnSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git(repo, ['add', 'a.txt']); git(repo, ['commit', '-q', '-m', 'a']);
  const io = {
    run: ({ args, cwd }) => {
      if (args[0] === 'workspace' && args[1] === 'create') {
        const wt = path.join(root, 'wt-' + args[2]);
        const r = cp.spawnSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', args[2], wt, 'main'], { encoding: 'utf8', env: GIT_ENV });
        if (r.status !== 0) return { ok: false, error: r.stderr };
        return { ok: true, raw: JSON.stringify({ path: wt }) };
      }
      return { ok: true, raw: '{}' };
    },
  };
  return { root, home, repo, io };
}

test('spawn: a numbered -p writes the plan keyed by the new worktree; a brief without one is never refused', () => {
  const f = spawnFixture();
  try {
    const brief = 'Build the thing\nScope: src/**\n1. read\n2. build\n3. ship';
    const r = cli.run(['spawn', 'feat-a', '-p', brief], { home: f.home, env: ENV, cwd: f.repo, io: f.io });
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(r.result.plan.written, true, JSON.stringify(r.result.plan));
    const wt = path.join(f.root, 'wt-feat-a');
    assert.strictEqual(r.result.plan.key, inst.primaryWorkspaceId(wt));
    const found = planLib.findPlan(f.home, { id: 'some-builder-id', worktreePath: wt });
    assert.ok(found, 'the child (any id) finds the plan through its worktree');
    assert.deepStrictEqual(found.plan.steps.map((s) => s.text), ['read', 'build', 'ship']);
    assert.deepStrictEqual(found.plan.scope_globs, ['src/**']);
    assert.strictEqual(found.plan.base, git(wt, ['rev-parse', 'HEAD']), 'base = the new worktree\'s fork point');

    const envReq = Object.assign({}, ENV, { ANTIHALL_DEVSWARM_PLAN_REQUIRED: '1' });
    const n = cli.run(['spawn', 'feat-b', '-p', 'just do it'], { home: f.home, env: envReq, cwd: f.repo, io: f.io });
    assert.strictEqual(n.code, 0, 'planRequired never refuses a spawn');
    assert.strictEqual(n.result.plan.written, false);
    assert.strictEqual(n.result.plan.reason, 'no-numbered-steps');
    assert.strictEqual(n.result.plan.required, true);

    const off = cli.run(['spawn', 'feat-c', '-p', '1. a\n2. b'], { home: f.home, env: Object.assign({}, ENV, { ANTIHALL_DEVSWARM_PLAN_TRACKING: '0' }), cwd: f.repo, io: f.io });
    assert.strictEqual(off.code, 0);
    assert.strictEqual(off.result.plan, undefined, 'planTracking off writes nothing');
    assert.strictEqual(planLib.findPlan(f.home, { worktreePath: path.join(f.root, 'wt-feat-c') }), null);

    const noP = cli.run(['spawn', 'feat-d'], { home: f.home, env: ENV, cwd: f.repo, io: f.io });
    assert.ok(!('plan' in JSON.parse(JSON.stringify(noP.result))), 'a spawn without -p carries no plan field');
  } finally { rm(f.root); }
});

test('no-plan rows are byte-identical: table normalizer and doneStateLabel unchanged, plan label ages normalized', () => {
  const noPlan = [
    'DEVSWARM WORKSPACES (re-sent on change, else every 10 turns):',
    '| workspace | status | finish | unread | last |',
    '|---|---|---|---|---|',
    '| wsA | active | working (40%) | 0 | 3m |',
    '| wsB | stale | done, merge unverified | 2 | 1h |',
  ].join('\n');
  const legacy = (t) => String(t).split('\n').map((l) => (/^\|.*\|\s*$/.test(l) ? l.replace(/\|[^|]*\|\s*$/, '| |') : l)).join('\n');
  assert.strictEqual(inbox.normalizeTableAges(noPlan), legacy(noPlan));
  const a = '| wsP | active | step 3/7 · 42m · progress 18m ago | 0 | 3m |';
  const b = '| wsP | active | step 3/7 · 43m · progress 19m ago | 0 | 4m |';
  assert.strictEqual(inbox.normalizeTableAges(a), inbox.normalizeTableAges(b), 'a ticking clock alone never re-sends the table');
  const c = '| wsP | active | step 4/7 · 0m · progress 0m ago | 0 | 4m |';
  assert.notStrictEqual(inbox.normalizeTableAges(a), inbox.normalizeTableAges(c), 'a step change still re-sends it');
  assert.strictEqual(inbox.doneStateLabel({ workspaces: { w: { gates: {} } } }, 'w', { progress_pct: 40 }), 'working (40%)');
});
