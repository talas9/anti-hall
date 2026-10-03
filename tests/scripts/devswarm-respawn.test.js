'use strict';
// Meeseeks P3 — `devswarm.js respawn <id> [--dry-run]`, the Primary-run
// replacement of a straying child that keeps its progress. Pins:
//   - refusals: not the Primary seat, no prior warning, grace not elapsed —
//     each before anything is sent, parked or spawned;
//   - --dry-run is side-effect free (refs, remote, worktree, home unchanged);
//   - a dirty worktree is parked on a NEW pushed park/<branch>-<ts> branch
//     without touching the child's worktree, then the new workspace is
//     spawned FROM THE DEFAULT BRANCH (`-s main`, never `-s <old branch>`)
//     with the handover + merge step + remaining steps, scope and extras;
//   - a failed push aborts the respawn (no spawn, local park branch kept);
//   - metrics: respawn / respawn-progress / done.respawnOf in the report.
// hivecontrol and the mesh send are stubs; the git remote is a local bare
// repo. Isolated HOME everywhere.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-resp-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const planLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-plan.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const metrics = require(path.join(ROOT, 'companion', 'lib', 'devswarm-supervision-metrics.js'));

const GIT_ENV = Object.assign({}, process.env, {
  HOME: LOG_DIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
});
// The verb's own git calls inherit process.env: keep them off the real home too.
for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) process.env[k] = GIT_ENV[k];
function git(cwd, args, allowFail) {
  const r = cp.spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0 && !allowFail) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return String(r.stdout || '').trim();
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const MIN = 60000;
const CHILD = '7e7e7e7e-1111-4222-8333-444455556666';

function fixture(opts) {
  const o = opts || {};
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-resp-home-')));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-resp-repo-')));
  const remote = path.join(base, 'remote.git');
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = path.join(base, 'main');
  git(base, ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['fetch', '-q', 'origin']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  const wt = path.join(base, 'feat-x');
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'feat-x']);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, ['add', '.']); git(wt, ['commit', '-q', '-m', 'step 1 work']);
  git(wt, ['push', '-q', 'origin', 'feat-x']);
  const env = {
    ANTIHALL_DEVSWARM_APP_DB: 'off', ANTIHALL_JEV: '0', CLAUDE_CODE_SESSION_ID: 'sess-p',
    ANTIHALL_DEVSWARM_RESPAWN_WIP_WAIT_SEC: '0', ANTIHALL_DEVSWARM_SPAWN_FROM_ORIGIN: '0', ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0',
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
  };
  const reg = cli.run(['register-primary'], { home, env, cwd: repo });
  assert.strictEqual(reg.result.ok, true, JSON.stringify(reg.result));
  const rk = repokey.repoKeyForWorktree(repo);
  const s = storeLib.openStore({ home, hash: rk });
  try { s.upsertRegistry({ id: CHILD, worktreePath: wt, sessionId: 'sess-c' }); } finally { s.close(); }
  const desc = path.join(home, '.anti-hall', 'devswarm', 'workspaces', CHILD + '.json');
  fs.mkdirSync(path.dirname(desc), { recursive: true });
  fs.writeFileSync(desc, JSON.stringify({ id: CHILD, worktreePath: wt, sessionId: 'sess-c', ownerKey: rk, repoKey: rk }));
  const now = Date.now();
  const key = planLib.planKeyForWorktree(wt);
  const plan = planLib.newPlan({ key, id: CHILD, worktreePath: wt, steps: ['read the code', 'write the fix', 'test it'], scope: ['src/**'], now: now - 120 * MIN });
  planLib.applyStep(plan, 1, 'done', now - 90 * MIN);
  planLib.applyStep(plan, 2, 'doing', now - 80 * MIN);
  planLib.recordSummary(plan, 'refactoring the parser instead of the fix', true, now - 60 * MIN);
  planLib.addExtra(plan, 'docs/**', 'user asked for a docs page', now - 70 * MIN);
  plan.warned_at = o.warnedAt === undefined ? now - 30 * MIN : o.warnedAt;
  planLib.savePlan(home, key, plan);
  const calls = { send: [], hc: [] };
  const newWt = path.join(base, 'feat-x-r2');
  const io = {
    send: (argv) => { calls.send.push(argv); return { code: 0, result: { ok: true } }; },
    // hivecontrol stub: `workspace create <branch> -s <source>` makes the
    // worktree the way the app would (a new branch off the source).
    run: (spec) => {
      calls.hc.push(spec.args);
      if (spec.args[0] === 'workspace' && spec.args[1] === 'create') {
        const b = spec.args[2];
        const si = spec.args.indexOf('-s');
        git(repo, ['worktree', 'add', '-q', newWt, '-b', b, si >= 0 ? spec.args[si + 1] : 'HEAD']);
      }
      return { ok: true, raw: '' };
    },
    newWorktreePath: newWt,
    sleep: () => {},
  };
  const ctx = (extra) => Object.assign({ home, env, cwd: repo, now, io }, extra || {});
  return { home, base, remote, repo, wt, newWt, env, key, now, calls, ctx, cleanup() { rm(home); rm(base); } };
}
function refsOf(dir) { return git(dir, ['for-each-ref', '--format=%(refname) %(objectname)']); }
function treeListing(dir) {
  const out = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(path.relative(dir, p) + ':' + st.size + ':' + fs.readFileSync(p, 'utf8'));
    }
  })(dir);
  return out.join('\n');
}
function events(home) {
  try { return fs.readFileSync(metrics.logPath(home), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (_) { return []; }
}

test('refusals: not the Primary seat, no warning, grace not elapsed — nothing sent, parked or spawned', () => {
  const f = fixture();
  try {
    const noSeat = cli.run(['respawn', CHILD], f.ctx({ env: Object.assign({}, f.env, { CLAUDE_CODE_SESSION_ID: 'sess-other' }) }));
    assert.strictEqual(noSeat.code, 2);
    assert.strictEqual(noSeat.result.reason, 'not-primary', JSON.stringify(noSeat.result));
    const fromChild = cli.run(['respawn', CHILD], f.ctx({ cwd: f.wt }));
    assert.strictEqual(fromChild.result.reason, 'not-primary', 'a child checkout never holds the Primary seat');
  } finally { f.cleanup(); }
  const g = fixture({ warnedAt: null });
  try {
    const r = cli.run(['respawn', CHILD], g.ctx());
    assert.strictEqual(r.result.reason, 'not-warned', JSON.stringify(r.result));
  } finally { g.cleanup(); }
  const h = fixture({ warnedAt: Date.now() - 5 * MIN });
  try {
    const r = cli.run(['respawn', CHILD], h.ctx());
    assert.strictEqual(r.result.reason, 'grace', JSON.stringify(r.result));
    assert.strictEqual(r.result.graceMin, 20);
    assert.ok(r.result.remainingMin >= 14 && r.result.remainingMin <= 16, String(r.result.remainingMin));
    const custom = cli.run(['respawn', CHILD, '--dry-run'], h.ctx({ env: Object.assign({}, h.env, { ANTIHALL_DEVSWARM_RESPAWN_GRACE_MIN: '3' }) }));
    assert.strictEqual(custom.result.ok, true, 'devswarm.respawnGraceMin is honoured: ' + JSON.stringify(custom.result));
    for (const fx of [h]) { assert.deepStrictEqual(fx.calls.send, []); assert.deepStrictEqual(fx.calls.hc, []); }
  } finally { h.cleanup(); }
});

test('--dry-run is side-effect free and plans a spawn from the default branch', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, 'wip.txt'), 'uncommitted\n');
    const before = { repo: refsOf(f.repo), remote: refsOf(f.remote), status: git(f.wt, ['status', '--porcelain']), home: treeListing(f.home) };
    const r = cli.run(['respawn', CHILD, '--dry-run'], f.ctx());
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(r.result.dryRun, true);
    assert.strictEqual(r.result.wouldPark, true);
    assert.strictEqual(r.result.newBranch, 'feat-x-r2');
    assert.deepStrictEqual(r.result.spawnArgs.slice(0, 3), ['feat-x-r2', '-s', 'main']);
    assert.match(r.result.spawnArgs[4], /^1\. Merge the previous work first: `git merge park\/feat-x-/m);
    assert.deepStrictEqual(f.calls.send, []);
    assert.deepStrictEqual(f.calls.hc, []);
    assert.strictEqual(refsOf(f.repo), before.repo, 'no local ref created');
    assert.strictEqual(refsOf(f.remote), before.remote, 'nothing pushed');
    assert.strictEqual(git(f.wt, ['status', '--porcelain']), before.status);
    assert.strictEqual(treeListing(f.home), before.home, 'no file written under HOME (no handover, no metrics, no plan change)');
  } finally { f.cleanup(); }
});

test('dirty worktree: parked on a new pushed branch, child untouched, spawned from main with the handover', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'b changed\n');
    fs.writeFileSync(path.join(f.wt, 'new.txt'), 'untracked work\n');
    const headBefore = git(f.wt, ['rev-parse', 'HEAD']);
    const statusBefore = git(f.wt, ['status', '--porcelain']);
    const r = cli.run(['respawn', CHILD], f.ctx());
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    const res = r.result;
    assert.strictEqual(res.parked, true);
    assert.match(res.parkBranch, /^park\/feat-x-\d{8}-\d{6}$/);
    // (a) the WIP request went to the child.
    assert.strictEqual(f.calls.send.length, 1);
    assert.deepStrictEqual(f.calls.send[0].slice(0, 3), ['send', '--to', CHILD]);
    // (b) park branch pushed, holding tracked + untracked work on top of HEAD.
    const remoteSha = git(f.remote, ['rev-parse', 'refs/heads/' + res.parkBranch]);
    assert.strictEqual(git(f.repo, ['rev-parse', res.parkBranch]), remoteSha);
    assert.strictEqual(git(f.repo, ['rev-parse', res.parkBranch + '^']), headBefore);
    assert.strictEqual(git(f.repo, ['show', res.parkBranch + ':new.txt']), 'untracked work');
    assert.strictEqual(git(f.repo, ['show', res.parkBranch + ':b.txt']), 'b changed');
    // The child's worktree, index, HEAD and branch are untouched (no stash, no discard).
    assert.strictEqual(git(f.wt, ['rev-parse', 'HEAD']), headBefore);
    assert.strictEqual(git(f.wt, ['status', '--porcelain']), statusBefore);
    assert.strictEqual(git(f.wt, ['symbolic-ref', '--short', 'HEAD']), 'feat-x');
    // (c) handover.
    const ho = fs.readFileSync(res.handoverPath, 'utf8');
    assert.strictEqual(res.handoverPath, path.join(planLib.plansDir(f.home), CHILD + '.handover.md'));
    assert.match(ho, /## Steps done\n- #1 read the code/);
    assert.match(ho, /## Remaining steps\n- #2 write the fix \(doing\)\n- #3 test it/);
    assert.match(ho, /refactoring the parser instead of the fix/);
    assert.match(ho, /`docs\/\*\*`: user asked for a docs page/);
    assert.ok(ho.includes(res.parkBranch));
    // (d) spawn from the DEFAULT branch, never `-s feat-x`.
    const create = f.calls.hc.find((a) => a[0] === 'workspace' && a[1] === 'create');
    assert.deepStrictEqual(create.slice(2, 5), ['feat-x-r2', '-s', 'main']);
    assert.ok(!create.includes('feat-x') || create.indexOf('feat-x') !== create.indexOf('-s') + 1);
    assert.strictEqual(git(f.newWt, ['rev-parse', 'HEAD']), git(f.repo, ['rev-parse', 'main']), 'new workspace starts at main');
    const np = planLib.findPlan(f.home, { worktreePath: f.newWt }).plan;
    assert.deepStrictEqual(np.steps.map((s) => s.text), [
      'Merge the previous work first: `git merge ' + res.parkBranch + '` (step 0 of the respawn), resolve conflicts, commit.',
      'write the fix', 'test it']);
    assert.deepStrictEqual(np.scope_globs, ['src/**']);
    assert.deepStrictEqual(np.extras.map((e) => [e.glob, e.note]), [['docs/**', 'user asked for a docs page']]);
    assert.strictEqual(np.respawn.from, CHILD);
    assert.strictEqual(np.respawn.park, res.parkBranch);
    // (e) old plan points at the new one; owner nag present.
    const op = planLib.findPlan(f.home, { worktreePath: f.wt }).plan;
    assert.strictEqual(op.respawned_to, res.newId);
    assert.match(res.nag, /Close the DevSwarm app tab for 7e7e7e7e/);
    assert.strictEqual(res.archived.ok, true, JSON.stringify(res.archived));
    assert.ok(!fs.existsSync(path.join(f.home, '.anti-hall', 'devswarm', 'workspaces', CHILD + '.json')), 'old id archived');
    // Metrics: respawn(parked) -> first step progress -> done with respawnOf.
    const evs = events(f.home);
    const rsp = evs.find((e) => e.type === 'respawn');
    assert.strictEqual(rsp.parked, true);
    assert.strictEqual(rsp.id, CHILD);
    const hb = cli.run(['heartbeat', res.newId, '--step', '1', '--status', 'done'], f.ctx({ cwd: f.newWt, now: f.now + 7 * MIN }));
    assert.strictEqual(hb.result.plan.changed, true, JSON.stringify(hb.result.plan));
    const prog = events(f.home).filter((e) => e.type === 'respawn-progress');
    assert.strictEqual(prog.length, 1);
    assert.strictEqual(prog[0].latencyMs, 7 * MIN);
    cli.run(['heartbeat', res.newId, '--step', '2', '--status', 'done'], f.ctx({ cwd: f.newWt, now: f.now + 9 * MIN }));
    assert.strictEqual(events(f.home).filter((e) => e.type === 'respawn-progress').length, 1, 'counted once');
    const rep = metrics.report(f.home, { days: 2, now: f.now + 10 * MIN });
    assert.deepStrictEqual(rep.respawns, { n: 1, parked: 1, notParked: 0, aborted: 0, withProgress: 1, medianFirstProgressMs: 7 * MIN, finished: 0 });
    assert.match(metrics.formatReport(rep), /respawns: +1 \(WIP parked 1, not parked 0, aborted 0\); first step progress in 1 \(median 7m\), finished 0/);
  } finally { f.cleanup(); }
});

test('A1-8: secret-shaped untracked files are excluded from the park branch and reported', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, 'new.txt'), 'untracked work\n');
    fs.writeFileSync(path.join(f.wt, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(f.wt, '.env.local'), 'SECRET=2\n');
    fs.writeFileSync(path.join(f.wt, 'id_rsa'), 'not a real key\n');
    fs.writeFileSync(path.join(f.wt, 'server.pem'), 'not a real cert\n');
    fs.writeFileSync(path.join(f.wt, 'credentials.json'), '{"k":"v"}\n');
    fs.writeFileSync(path.join(f.wt, '.npmrc'), '//registry/:_authToken=x\n');
    const r = cli.run(['respawn', CHILD], f.ctx());
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    const res = r.result;
    assert.strictEqual(res.parked, true);
    // Ordinary untracked work still rides along.
    assert.strictEqual(git(f.repo, ['show', res.parkBranch + ':new.txt']), 'untracked work');
    // None of the secret-shaped files reached the pushed park branch.
    const parkedFiles = git(f.repo, ['ls-tree', '-r', '--name-only', res.parkBranch]).split('\n');
    for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'credentials.json', '.npmrc']) {
      assert.ok(!parkedFiles.includes(name), name + ' must not be on the park branch: ' + parkedFiles.join(','));
    }
    assert.ok(parkedFiles.includes('new.txt'));
    // Reported back, not silently dropped.
    assert.deepStrictEqual(res.untrackedIncluded.sort(), ['new.txt']);
    assert.deepStrictEqual(
      res.untrackedExcluded.sort(),
      ['.env', '.env.local', '.npmrc', 'credentials.json', 'id_rsa', 'server.pem'],
    );
    // The excluded files are still sitting untouched in the child's worktree
    // (never deleted, never staged, never pushed anywhere).
    for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'credentials.json', '.npmrc']) {
      assert.ok(fs.existsSync(path.join(f.wt, name)), name + ' still present in the worktree');
    }
  } finally { f.cleanup(); }
});

test('a failed push aborts the respawn: nothing spawned, the local park branch keeps the work', () => {
  const f = fixture();
  try {
    const hook = path.join(f.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by test remote" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(f.wt, 'new.txt'), 'must not be lost\n');
    const r = cli.run(['respawn', CHILD], f.ctx());
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.result.reason, 'park-failed', JSON.stringify(r.result));
    assert.strictEqual(r.result.park.stage, 'push');
    const pb = r.result.park.parkBranch;
    assert.strictEqual(git(f.repo, ['show', pb + ':new.txt']), 'must not be lost', 'local park branch holds the work');
    assert.strictEqual(git(f.remote, ['rev-parse', '-q', '--verify', 'refs/heads/' + pb], true), '', 'not on the remote');
    assert.ok(!f.calls.hc.some((a) => a[1] === 'create'), 'no spawn');
    assert.ok(!fs.existsSync(path.join(planLib.plansDir(f.home), CHILD + '.handover.md')), 'no handover');
    assert.ok(fs.existsSync(path.join(f.wt, 'new.txt')), 'the child worktree is untouched');
    assert.ok(!planLib.findPlan(f.home, { worktreePath: f.wt }).plan.respawned_to);
    const ab = events(f.home).filter((e) => e.type === 'respawn-aborted');
    assert.deepStrictEqual(ab.map((e) => e.stage), ['push']);
  } finally { f.cleanup(); }
});

test('clean and pushed worktree: no park branch, the step-1 merge names the old branch', () => {
  const f = fixture();
  try {
    const r = cli.run(['respawn', CHILD], f.ctx());
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(r.result.parked, false);
    assert.strictEqual(r.result.parkBranch, null);
    assert.strictEqual(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/park']), '');
    const np = planLib.findPlan(f.home, { worktreePath: f.newWt }).plan;
    assert.match(np.steps[0].text, /^Merge the previous work first: `git merge feat-x`/);
    assert.strictEqual(events(f.home).find((e) => e.type === 'respawn').parked, false);
  } finally { f.cleanup(); }
});
