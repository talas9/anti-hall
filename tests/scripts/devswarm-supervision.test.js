'use strict';
// Meeseeks supervision P2 — straying detection, correction, extras, the five
// Jev integrations (shadow) and the effectiveness metrics. Pins:
//   - stall and off-scope fixtures warn EXACTLY once (a second sweep with the
//     same episode issues nothing); strayWarnMax caps new episodes per step;
//   - `scope add` extras suppress the off-scope warning (real git fixture);
//   - Jev off -> deterministic signals only, no ask, no Jev state;
//   - Jev (default on = recommendation) -> asked once (detached); the cached
//     answer annotates the warning (never removes it), is logged as a `jev`
//     metrics event, and a correction records follow/override; shadow shows
//     nothing;
//   - token burn: incremental transcript read, burn warns once, tokens metrics;
//   - `correct` records warned_at only after a successful send;
//   - metrics: events are written, the rollup is correct, the report prints;
//   - no plan -> evaluateChild/superviseStraying return null.
// Isolated HOME everywhere (every home is a temp dir).

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sup-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const planLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-plan.js'));
const sup = require(path.join(ROOT, 'companion', 'lib', 'devswarm-supervision.js'));
const supJev = require(path.join(ROOT, 'companion', 'lib', 'devswarm-supervision-jev.js'));
const metrics = require(path.join(ROOT, 'companion', 'lib', 'devswarm-supervision-metrics.js'));
const supervisor = require(path.join(ROOT, 'companion', 'devswarm-supervisor.js'));
const jevAssist = require(path.join(ROOT, 'hooks', 'lib', 'jev-assist.js'));

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sup-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
// Jev forced off unless a test turns it on; no app DB.
const ENV = { ANTIHALL_DEVSWARM_APP_DB: 'off', ANTIHALL_JEV: '0' };
const MIN = 60000;

function seed(home, key, steps, mutate, scope) {
  const now = Date.now();
  const plan = planLib.newPlan({ key, id: key, steps, scope: scope || [], now: now - 120 * MIN });
  if (mutate) mutate(plan, now);
  planLib.savePlan(home, key, plan);
  return plan;
}
function events(home) {
  try { return fs.readFileSync(metrics.logPath(home), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (_) { return []; }
}
const noJev = { jevAdjust: false, readyCheck: () => null };

test('stall: a busy child with no step progress for stepStallMin warns exactly once', () => {
  const home = tmpHome();
  try {
    seed(home, 'ch-stall', ['read', 'fix', 'test'], (p, now) => { planLib.applyStep(p, 1, 'doing', now - 45 * MIN); });
    const d = { id: 'ch-stall', worktreePath: null };
    const now = Date.now();
    const a = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps: noJev });
    assert.deepStrictEqual(a.issued.map((s) => s.signal), ['stall']);
    const b = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now: now + 90000, deps: noJev });
    assert.deepStrictEqual(b.signals.map((s) => s.signal), ['stall'], 'still stalled');
    assert.deepStrictEqual(b.issued, [], 'same episode -> no second warning');
    const stray = planLib.readStray(home, 'ch-stall');
    assert.strictEqual(stray.active.length, 1);
    assert.strictEqual(stray.active[0].signal, 'stall');
    const warns = events(home).filter((e) => e.type === 'warn');
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0].signal, 'stall');
    assert.strictEqual(warns[0].repeat, false);

    // Under the window: no signal at all.
    const fresh = sup.evaluateChild(d, { status: 'alive' }, { home, env: Object.assign({ ANTIHALL_DEVSWARM_STEP_STALL_MIN: '60' }, ENV), now, deps: noJev });
    assert.deepStrictEqual(fresh.signals, []);
    // strayWarnMax 0 -> signals are computed but nothing is issued.
    const off = sup.evaluateChild({ id: 'ch-stall' }, { status: 'alive' }, { home, env: Object.assign({ ANTIHALL_DEVSWARM_STRAY_WARN_MAX: '0' }, ENV), now: now + 99 * MIN, deps: noJev });
    assert.deepStrictEqual(off.issued, []);
  } finally { rm(home); }
});

test('dormant workspace: stall/idle/burn signals are suppressed (and cleared); a live one still stalls', () => {
  const home = tmpHome();
  try {
    seed(home, 'ch-dorm', ['read', 'fix', 'test'], (p, now) => { planLib.applyStep(p, 1, 'doing', now - 45 * MIN); });
    const d = { id: 'ch-dorm', worktreePath: null };
    const now = Date.now();
    const live = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps: noJev });
    assert.deepStrictEqual(live.signals.map((s) => s.signal), ['stall']);
    const dormantDeps = Object.assign({ rowLivenessState: () => 'dormant' }, noJev);
    const a = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps: dormantDeps });
    const b = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps: dormantDeps });
    assert.deepStrictEqual(a.signals, []);
    assert.deepStrictEqual(a.signals, b.signals, 'deterministic for the same state');
    assert.deepStrictEqual(planLib.readStray(home, 'ch-dorm').active, [], 'stale STRAYING state cleared');
    const stale = sup.evaluateChild(d, { status: 'stale', staleSince: now - 20 * MIN }, { home, env: ENV, now, deps: dormantDeps });
    assert.deepStrictEqual(stale.signals, [], 'idle suppressed too');
  } finally { rm(home); }
});

test('stall: a new episode on the same step repeats, capped at strayWarnMax', () => {
  const home = tmpHome();
  try {
    seed(home, 'ch-rep', ['a', 'b'], (p, now) => { planLib.applyStep(p, 1, 'doing', now - 45 * MIN); });
    const d = { id: 'ch-rep' };
    let now = Date.now();
    const issued = [];
    for (let i = 0; i < 4; i++) {
      const r = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps: noJev });
      issued.push(...r.issued);
      // A correction restarts the stall clock -> the next stall is a new episode.
      const f = planLib.findPlan(home, { id: 'ch-rep' });
      f.plan.warned_at = now; planLib.savePlan(home, f.key, f.plan);
      now += 31 * MIN;
    }
    assert.strictEqual(issued.length, 2, 'default strayWarnMax 2');
    assert.deepStrictEqual(issued.map((s) => s.repeat), [false, true]);
    assert.strictEqual(events(home).filter((e) => e.type === 'warn' && e.repeat).length, 1);
  } finally { rm(home); }
});

test('idle: a stale verdict is an idle signal (not stall); no plan -> null', () => {
  const home = tmpHome();
  try {
    seed(home, 'ch-idle', ['a', 'b']);
    const r = sup.evaluateChild({ id: 'ch-idle' }, { status: 'stale', staleSince: Date.now() - 20 * MIN }, { home, env: ENV, deps: noJev });
    assert.deepStrictEqual(r.issued.map((s) => s.signal), ['idle']);
    assert.strictEqual(sup.evaluateChild({ id: 'nope' }, { status: 'alive' }, { home, env: ENV, deps: noJev }), null);
    assert.strictEqual(supervisor.superviseStraying({ id: 'nope' }, { status: 'alive' }, { home, env: ENV, deps: { supervision: noJev } }), null);
    assert.ok(!fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'stray', 'nope.json')));
    // planTracking off -> nothing, even with a plan.
    assert.strictEqual(sup.evaluateChild({ id: 'ch-idle' }, { status: 'stale' }, { home, env: Object.assign({ ANTIHALL_DEVSWARM_PLAN_TRACKING: '0' }, ENV), deps: noJev }), null);
  } finally { rm(home); }
});

test('off-scope (real git): warns once; `scope add` extras suppress it', () => {
  const home = tmpHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sup-repo-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), '1');
    git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']);
    git(repo, ['checkout', '-qb', 'feat']);
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), '2');
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs', 'x.md'), 'x');
    git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'work']);
    const key = 'ch-off';
    const plan = planLib.newPlan({ key, id: key, worktreePath: repo, steps: ['a', 'b'], scope: ['src/**'], base: 'main', now: Date.now() });
    planLib.savePlan(home, key, plan);
    const d = { id: key, worktreePath: repo };
    const deps = { jevAdjust: false };
    const now = Date.now();
    const a = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps });
    assert.deepStrictEqual(a.issued.map((s) => s.signal), ['off-scope']);
    assert.deepStrictEqual(a.issued[0].files, ['docs/x.md']);
    const b = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now: now + 90000, deps });
    assert.deepStrictEqual(b.issued, [], 'same file set -> no second warning');

    const r = cli.run(['scope', 'add', key, '--glob', 'docs/**', '--note', 'user asked for the docs page'], { home, env: ENV, cwd: os.tmpdir(), now });
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(r.result.changed, true);
    const again = cli.run(['scope', 'add', key, '--glob', 'docs/**', '--note', 'user asked for the docs page'], { home, env: ENV, cwd: os.tmpdir(), now });
    assert.strictEqual(again.result.changed, false, 'idempotent');
    assert.strictEqual(cli.run(['scope', 'add', key, '--glob', 'x/**'], { home, env: ENV, cwd: os.tmpdir() }).code, 2, '--note required');
    const c = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now: now + 180000, deps });
    assert.deepStrictEqual(c.signals, [], 'the extra glob sanctions docs/**');
    assert.strictEqual(events(home).filter((e) => e.type === 'extra').length, 1);
  } finally { rm(home); rm(repo); }
});

test('correct: builds the template, records warned_at only after a successful send', () => {
  const home = tmpHome();
  try {
    seed(home, 'ch-cor', ['read the code', 'fix it'], (p, now) => { planLib.applyStep(p, 1, 'doing', now - 45 * MIN); });
    sup.evaluateChild({ id: 'ch-cor' }, { status: 'alive' }, { home, env: ENV, deps: noJev });
    const ctx = (send) => ({ home, env: ENV, cwd: os.tmpdir(), now: 5000, io: { send } });
    const dry = cli.cmdCorrect('ch-cor', { 'dry-run': [true] }, ctx(() => { throw new Error('must not send'); }));
    assert.ok(/^step 1 'read the code': no step progress \d+m\. Return to step 1 or reply BLOCKED <why>\./.test(dry.message), dry.message);
    const failed = cli.cmdCorrect('ch-cor', {}, ctx(() => ({ code: 2, result: { ok: false } })));
    assert.strictEqual(failed.ok, false);
    assert.ok(!Number.isFinite(planLib.findPlan(home, { id: 'ch-cor' }).plan.warned_at), 'no warned_at on a failed send');
    let argv = null;
    const ok = cli.cmdCorrect('ch-cor', {}, ctx((a) => { argv = a; return { code: 0, result: { ok: true } }; }));
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(argv.slice(0, 3), ['send', '--to', 'ch-cor']);
    assert.strictEqual(planLib.findPlan(home, { id: 'ch-cor' }).plan.warned_at, 5000);
    assert.strictEqual(cli.cmdCorrect('nope', {}, ctx(() => ({ code: 0 }))).reason, 'no-plan');

    // Step progress within stepStallMin of the correction -> correction-followed.
    const hb = cli.run(['heartbeat', 'ch-cor', '--step', '1', '--status', 'done'], { home, env: ENV, cwd: os.tmpdir(), now: 5000 + 10 * MIN });
    assert.strictEqual(hb.code, 0, JSON.stringify(hb.result));
    const types = events(home).map((e) => e.type);
    assert.ok(types.includes('correction') && types.includes('correction-followed'), types.join(','));
  } finally { rm(home); }
});

// ---- Jev --------------------------------------------------------------------

function jevOn(home, modes) {
  fs.writeFileSync(path.join(home, '.anti-hall', 'jev.json'), JSON.stringify({ enabled: true }));
  if (modes) fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ jevIntegrations: modes }));
}
const JEV_ENV = { ANTIHALL_DEVSWARM_APP_DB: 'off' };
function stallFixture(home) {
  seed(home, 'ch-j', ['read', 'fix'], (p, now) => {
    planLib.applyStep(p, 1, 'doing', now - 45 * MIN);
    planLib.recordSummary(p, 'waiting for CI on PR 12', true, now - 45 * MIN);
    p.scope_globs = ['src/**'];
  });
  return { id: 'ch-j', worktreePath: path.join(home, 'no-such-worktree') };
}
const jevDeps = (asked) => ({ readyCheck: () => ({ ok: true, outside_allowed: ['docs/a.md'] }), jev: { askDetached: (o) => asked.push(o), gitRecent: () => ({ subjects: [], churn: [] }), recentUserPrompts: () => [] } });
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('jev off: deterministic signals only — no ask, no Jev state, no jev-assist log', () => withEnv({ ANTIHALL_JEV: '0' }, () => {
  const home = tmpHome();
  try {
    const asked = [];
    const r = sup.evaluateChild(stallFixture(home), { status: 'alive' }, { home, env: JEV_ENV, deps: Object.assign(jevDeps(asked), { readyCheck: () => null }) });
    assert.deepStrictEqual(r.signals.map((s) => s.signal), ['stall']);
    assert.strictEqual(asked.length, 0);
    assert.ok(!fs.existsSync(supJev.statePath(home, 'ch-j')));
    assert.ok(!fs.existsSync(jevAssist.logPath(home)));
  } finally { rm(home); }
}));

test('jev (default on = recommendation): asked once per input; the answer annotates the warning, never removes it; shadow shows nothing', () => withEnv({ ANTIHALL_JEV: null }, () => {
  const home = tmpHome();
  try {
    jevOn(home);
    const d = stallFixture(home);
    const asked = [];
    const now = Date.now();
    const a = sup.evaluateChild(d, { status: 'alive' }, { home, env: JEV_ENV, now, deps: jevDeps(asked) });
    assert.deepStrictEqual(a.signals.map((s) => s.signal), ['stall', 'off-scope']);
    const wait = asked.filter((o) => o.id === 'devswarmOnBrief');
    assert.strictEqual(wait.length, 1, 'asked detached once');
    assert.ok(wait[0].state.length <= 1500, 'input cap');
    sup.evaluateChild(d, { status: 'alive' }, { home, env: JEV_ENV, now: now + 90000, deps: jevDeps(asked) });
    assert.strictEqual(asked.filter((o) => o.id === 'devswarmOnBrief').length, 1, 'same input inside the re-ask window -> no second ask');

    // Simulate the detached worker's cache fill: Jev says "not stuck" (confident).
    const p = jevAssist.prepare({ id: 'devswarmOnBrief', home, trust: 'relax-block', baseline: true, cacheKey: wait[0].cacheKey, state: wait[0].state });
    assert.strictEqual(p.mode, 'on', 'default mode is on');
    fs.mkdirSync(path.dirname(jevAssist.cachePath(home)), { recursive: true });
    fs.writeFileSync(jevAssist.cachePath(home), JSON.stringify({ [p.hash]: { answer: false, confidence: 0.92, _seq: 1 } }));
    const c = sup.evaluateChild(d, { status: 'alive' }, { home, env: JEV_ENV, now: now + 180000, deps: jevDeps(asked) });
    assert.deepStrictEqual(c.signals.map((s) => s.signal), ['stall', 'off-scope'], 'never suppresses the deterministic warning');
    assert.deepStrictEqual(c.signals[1].jev, [{ integration: 'devswarmOnBrief', verdict: 'on-brief', confidence: 0.92, supports: false }]);
    const active = planLib.readStray(home, 'ch-j').active;
    assert.strictEqual(active.find((x) => x.signal === 'off-scope').jev[0].verdict, 'on-brief');
    assert.match(sup.strayingLine([{ id: 'ch-j', step: 1, reason: active.find((x) => x.signal === 'off-scope').reason, jev: active.find((x) => x.signal === 'off-scope').jev }]), /\(Jev: on-brief 0\.92\)/);
    const j = events(home).filter((e) => e.type === 'jev');
    assert.strictEqual(j.length, 1);
    assert.deepStrictEqual([j[0].integration, j[0].mode, j[0].agree], ['devswarmOnBrief', 'on', false]);
    sup.evaluateChild(d, { status: 'alive' }, { home, env: JEV_ENV, now: now + 270000, deps: jevDeps(asked) });
    assert.strictEqual(events(home).filter((e) => e.type === 'jev').length, 1, 'one jev event per answered input');

    // The Primary corrects anyway -> an override of Jev's recommendation is recorded.
    const cor = cli.cmdCorrect('ch-j', {}, { home, env: JEV_ENV, cwd: os.tmpdir(), now: now + 300000, io: { send: () => ({ code: 0, result: { ok: true } }) } });
    assert.strictEqual(cor.ok, true);
    const ce = events(home).find((e) => e.type === 'correction');
    assert.deepStrictEqual(ce.jev, [{ integration: 'devswarmOnBrief', supports: false }]);
    const rep = metrics.report(home, { days: 1 });
    assert.strictEqual(rep.jev.devswarmOnBrief.overridden, 1);
    assert.strictEqual(rep.jev.devswarmOnBrief.followRate, 0);

    // shadow: logged and cached, but nothing is shown on the warning.
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ jevIntegrations: { devswarmOnBrief: 'shadow' } }));
    const sh = sup.evaluateChild(d, { status: 'alive' }, { home, env: JEV_ENV, now: now + 300000 + 31 * MIN, deps: jevDeps(asked) });
    assert.deepStrictEqual(sh.signals.map((s) => s.signal), ['stall', 'off-scope']);
    assert.strictEqual(sh.signals[1].jev, undefined);
  } finally { rm(home); }
}));

test('jev scrubs secrets and caps every input', () => withEnv({ ANTIHALL_JEV: null }, () => {
  const home = tmpHome();
  try {
    jevOn(home);
    seed(home, 'ch-s', ['a', 'b'], (p, now) => {
      planLib.applyStep(p, 1, 'doing', now - 200 * MIN);
      planLib.recordSummary(p, 'token=abcdef123456 ' + 'x'.repeat(150), false, now - 150 * MIN); // old: the child must still read as stalled
    });
    const asked = [];
    const deps = jevDeps(asked);
    deps.readyCheck = () => ({ ok: true, outside_allowed: ['docs/a.md'] });
    deps.jev.recentUserPrompts = () => ['please also fix the docs, key=SECRETVALUE'];
    const plan = planLib.findPlan(home, { id: 'ch-s' }).plan;
    plan.scope_globs = ['src/**']; planLib.savePlan(home, 'ch-s', plan);
    sup.evaluateChild({ id: 'ch-s', worktreePath: path.join(home, 'no-such-worktree') }, { status: 'alive' }, { home, env: JEV_ENV, deps });
    const ids = asked.map((o) => o.id).sort();
    assert.deepStrictEqual(ids, ['devswarmExtraSanctioned', 'devswarmOnBrief'], 'WaitKind, Loop and StepMap are asked by the engine sweep, never by Node');
    for (const o of asked) {
      assert.ok(!/abcdef123456|SECRETVALUE/.test(o.state), o.id + ' leaks: ' + o.state);
      assert.ok(o.state.length <= { devswarmOnBrief: 1500, devswarmExtraSanctioned: 1000 }[o.id]);
    }
  } finally { rm(home); }
}));

test('jev trigger counter: an off-scope signal records "seen" once per episode, and "skipped" when the integration is off', () => withEnv({ ANTIHALL_JEV: null }, () => {
  const home = tmpHome();
  try {
    jevOn(home);
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ jevIntegrations: { devswarmOnBrief: 'off' } }));
    seed(home, 'ch-t', ['a', 'b'], (p, now) => { planLib.applyStep(p, 1, 'doing', now - 10 * MIN); });
    const asked = [];
    const deps = jevDeps(asked);
    deps.readyCheck = () => ({ ok: true, outside_allowed: ['docs/a.md'] });
    deps.jev.recentUserPrompts = () => ['please also fix the docs'];
    const plan = planLib.findPlan(home, { id: 'ch-t' }).plan;
    plan.scope_globs = ['src/**']; planLib.savePlan(home, 'ch-t', plan);
    const d = { id: 'ch-t', worktreePath: path.join(home, 'no-such-worktree') };
    const now = Date.now();
    sup.evaluateChild(d, { status: 'alive' }, { home, env: JEV_ENV, now, deps });
    sup.evaluateChild(d, { status: 'alive' }, { home, env: JEV_ENV, now: now + 1000, deps });
    const t = events(home).filter((e) => e.type === 'jev-trigger');
    const by = (i, o) => t.filter((e) => e.integration === i && e.outcome === o);
    assert.strictEqual(by('devswarmOnBrief', 'seen').length, 1, 'once per episode: ' + JSON.stringify(t));
    assert.strictEqual(by('devswarmExtraSanctioned', 'seen').length, 1);
    assert.strictEqual(by('devswarmOnBrief', 'skipped').length, 1, 'off integration -> skipped');
    assert.strictEqual(by('devswarmOnBrief', 'skipped')[0].reason, 'mode-off-or-jev-disabled');
    assert.strictEqual(by('devswarmExtraSanctioned', 'skipped').length, 0, 'still on -> not skipped');
  } finally { rm(home); }
}));

// ---- token burn ---------------------------------------------------------

const tokenUsage = require(path.join(ROOT, 'companion', 'lib', 'devswarm-token-usage.js'));
const { projectDirFor } = require(path.join(ROOT, 'companion', 'lib', 'target-session.js'));
function assistant(id, ts, usage) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id, role: 'assistant', usage } }) + '\n';
}

test('token burn: incremental transcript read, one count per message id, cache reads weighted, since-step resets', () => {
  const home = tmpHome();
  try {
    const wt = path.join(home, 'wt', 'ch-b');
    const d = { id: 'ch-b', worktreePath: wt, sessionId: 'aaaa-1111' };
    const file = path.join(projectDirFor(wt, home), 'aaaa-1111.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t0 = Date.now() - 60 * MIN;
    const u = { input_tokens: 100, output_tokens: 900, cache_creation_input_tokens: 1000, cache_read_input_tokens: 100000 };
    // Two entries share msg_1 (one per content block) -> counted once; a user line is ignored.
    fs.writeFileSync(file, assistant('msg_1', t0, u) + assistant('msg_1', t0, u)
      + JSON.stringify({ type: 'user', message: { content: 'hi "usage"' } }) + '\n' + assistant('msg_2', t0 + 1000, u));
    const one = 100 + 900 + 1000 + 0.1 * 100000; // 12000
    const r1 = tokenUsage.update(home, 'ch-b', d, t0 - 1000, { cacheReadWeight: 0.1 });
    assert.strictEqual(r1.total, 2 * one);
    assert.strictEqual(r1.sinceStep, 2 * one);
    const off1 = tokenUsage.readState(home, 'ch-b').offset;
    assert.strictEqual(off1, fs.statSync(file).size, 'offset at end of complete lines');
    // A partial trailing line is not consumed until it is complete.
    fs.appendFileSync(file, assistant('msg_3', t0 + 5 * MIN, u).slice(0, 40));
    assert.strictEqual(tokenUsage.update(home, 'ch-b', d, t0 - 1000, { cacheReadWeight: 0.1 }).total, 2 * one);
    fs.appendFileSync(file, assistant('msg_3', t0 + 5 * MIN, u).slice(40));
    // Step progress at t0+2m: the mark moves; the closed period is returned, msg_3 (after the mark) counts toward sinceStep.
    const r3 = tokenUsage.update(home, 'ch-b', d, t0 + 2 * MIN, { cacheReadWeight: 0.1 });
    assert.strictEqual(r3.total, 3 * one);
    assert.strictEqual(r3.closed.tokens, 2 * one);
    assert.strictEqual(r3.sinceStep, one);
    assert.strictEqual(tokenUsage.fmt(1800000), '1.8M');
    assert.strictEqual(tokenUsage.fmt(420000), '420k');
  } finally { rm(home); }
});

test('token burn: over burnTokensWarn with no step change warns exactly once; correction names the tokens; table/roster show them', () => {
  const home = tmpHome();
  try {
    const wt = path.join(home, 'wt', 'ch-burn');
    seed(home, 'ch-burn', ['read', 'fix'], (p, now) => { planLib.applyStep(p, 1, 'doing', now - 10 * MIN); });
    const d = { id: 'ch-burn', worktreePath: wt, sessionId: 'bbbb-2222' };
    const file = path.join(projectDirFor(wt, home), 'bbbb-2222.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body = '';
    for (let i = 0; i < 30; i++) body += assistant('m' + i, Date.now() - 5 * MIN, { input_tokens: 10, output_tokens: 4000, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 });
    fs.writeFileSync(file, body); // 30 x 24010 = 720300 weighted
    const env = Object.assign({ ANTIHALL_DEVSWARM_BURN_TOKENS_WARN: '500000' }, ENV);
    const now = Date.now();
    const a = sup.evaluateChild(d, { status: 'alive' }, { home, env, now, deps: noJev });
    assert.deepStrictEqual(a.issued.map((s) => s.signal), ['burn']);
    assert.strictEqual(a.issued[0].reason, 'used 720k tokens since step 1 last moved');
    const b = sup.evaluateChild(d, { status: 'alive' }, { home, env, now: now + 90000, deps: noJev });
    assert.deepStrictEqual(b.issued, [], 'same step period -> no second burn warning');
    const dry = cli.cmdCorrect('ch-burn', { 'dry-run': [true] }, { home, env, cwd: os.tmpdir(), now });
    assert.match(dry.message, /^step 1 'read': used 720k tokens since step 1 last moved\. Return to step 1/);
    // Burn corrected: correction -> step progress within the window -> burn corrected rate.
    cli.cmdCorrect('ch-burn', {}, { home, env, cwd: os.tmpdir(), now, io: { send: () => ({ code: 0, result: { ok: true } }) } });
    const hb = cli.run(['heartbeat', 'ch-burn', '--step', '1', '--status', 'done'], { home, env, cwd: os.tmpdir(), now: now + 5 * MIN });
    assert.strictEqual(hb.code, 0, JSON.stringify(hb.result));
    assert.strictEqual(planLib.findPlan(home, { id: 'ch-burn' }).plan.step_ts, now + 5 * MIN, JSON.stringify(hb.result));
    // The next sweep closes the step period -> a `tokens` event.
    sup.evaluateChild(d, { status: 'alive' }, { home, env, now: now + 6 * MIN, deps: noJev });
    const tokEv = events(home).filter((e) => e.type === 'tokens');
    assert.strictEqual(tokEv.length, 1);
    assert.strictEqual(tokEv[0].tokens, 720300);
    const rep = metrics.report(home, { days: 1 });
    assert.strictEqual(rep.tokens.burn.warnings, 1);
    assert.strictEqual(rep.tokens.burn.corrections, 1);
    assert.strictEqual(rep.tokens.burn.correctedRate, 1);
    assert.strictEqual(rep.tokens.byWorkspace['ch-burn'], 720300);
    assert.match(metrics.formatReport(rep), /token burn:\s+1 warning\(s\), 1 correction\(s\), 1 followed by progress \(100%\)/);
    // Off (0) -> no burn signal even with a large since-step figure.
    fs.appendFileSync(file, body.replace(/"m(\d+)"/g, '"n$1"').replace(/"timestamp":"[^"]+"/g, '"timestamp":"' + new Date(now + 7 * MIN).toISOString() + '"'));
    const off = sup.evaluateChild(d, { status: 'alive' }, { home, env: Object.assign({}, env, { ANTIHALL_DEVSWARM_BURN_TOKENS_WARN: '0' }), now: now + 8 * MIN, deps: noJev });
    assert.ok(off.usage.sinceStep >= 500000, 'precondition: over the default-free threshold');
    assert.ok(!off.signals.some((s) => s.signal === 'burn'));
  } finally { rm(home); }
});

// ---- metrics ----------------------------------------------------------------

test('metrics: rollup counts each measure; the report verb prints text and JSON', () => {
  const home = tmpHome();
  try {
    const day = Date.parse('2026-09-20T10:00:00Z');
    const rec = (type, f) => metrics.record(home, type, Object.assign({ now: day, id: 'c1' }, f));
    rec('plan', { source: 'spawn', steps: 3 });
    rec('step', { step: 1, status: 'done' });
    rec('warn', { signal: 'stall', repeat: false });
    rec('warn', { signal: 'stall', repeat: true });
    rec('warn', { signal: 'off-scope', repeat: false });
    rec('correction', {});
    rec('correction', {});
    rec('correction-followed', {});
    rec('extra', { globs: 1 });
    rec('done', { durationMs: 3 * 3600000, stepsDone: 3, stepsPlanned: 3 });
    rec('done', { durationMs: 1 * 3600000, stepsDone: 1, stepsPlanned: 2 });
    rec('jev', { integration: 'devswarmWaitKind', mode: 'shadow', agree: true });
    rec('jev', { integration: 'devswarmWaitKind', mode: 'shadow', agree: false });
    const roll = metrics.buildDailyRollups(events(home)).get('2026-09-20');
    assert.deepStrictEqual(roll.warnings, { stall: 2, 'off-scope': 1 });
    assert.strictEqual(roll.repeats, 1);
    assert.strictEqual(roll.corrections, 2);
    assert.strictEqual(roll.correctionsFollowed, 1);
    assert.strictEqual(roll.extras, 1);
    assert.strictEqual(roll.done, 2);
    assert.strictEqual(roll.stepsDone, 4);
    assert.strictEqual(roll.stepsPlanned, 5);
    assert.deepStrictEqual(roll.jev.devswarmWaitKind, { n: 2, agree: 1, followed: 0, overridden: 0, progressWhenSupported: 0, progressWhenNotSupported: 0, byMode: { shadow: 2 } });

    assert.strictEqual(metrics.writeDailyRollups(home), 1);
    const file = path.join(metrics.dailyDir(home), '2026-09-20.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).corrections, 2);

    const now = Date.parse('2026-09-21T12:00:00Z');
    const r = cli.run(['supervision-report', '--days', '3'], { home, env: ENV, cwd: os.tmpdir(), now });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.result.warnings.total, 3);
    assert.strictEqual(r.result.corrections.followRate, 0.5);
    assert.strictEqual(r.result.done.medianDurationMs, 3600000);
    assert.strictEqual(r.result.jev.devswarmWaitKind.agreeRate, 0.5);
    const text = metrics.formatReport(r.result);
    assert.match(text, /straying warnings:\s+3 \(stall 2, off-scope 1; repeats 1\)/);
    assert.match(text, /corrections:\s+2 sent, 1 followed by step progress \(50%\)/);
    assert.match(text, /steps 4\/5/);
    assert.match(text, /Jev devswarmWaitKind: 1\/2 agree/);
    // Out of the window -> empty.
    const old = cli.run(['supervision-report', '--days', '1'], { home, env: ENV, cwd: os.tmpdir(), now: now + 5 * 86400000 });
    assert.strictEqual(old.result.warnings.total, 0);
    // A day whose raw rows rotated away still reports from its rollup.
    fs.unlinkSync(metrics.logPath(home));
    const fromRollup = cli.run(['supervision-report', '--days', '3', '--json'], { home, env: ENV, cwd: os.tmpdir(), now });
    assert.strictEqual(fromRollup.result.warnings.total, 3);
    assert.strictEqual(metrics.doctorLine(home, now), null, 'no log -> no doctor line');
    rec('warn', { signal: 'idle' });
    assert.match(metrics.doctorLine(home, now), /^supervision \(7d\): /);
    assert.strictEqual(cli.run(['supervision-report', '--days', '0'], { home, env: ENV, cwd: os.tmpdir() }).code, 2);
  } finally { rm(home); }
});

test('strayingLine is capped and names the correct verb', () => {
  const e = (i) => ({ id: 'w' + i, step: 2, reason: 'no step progress 40m' });
  const line = sup.strayingLine([e(1), e(2), e(3), e(4), e(5)], (id) => (id === 'w1' ? 'Fix the parser' : null));
  assert.ok(line.startsWith('⚠️ anti-hall · devswarm-straying: Fix the parser: step 2 no step progress 40m; w2: '), line);
  assert.ok(line.includes('(+2 more)'));
  assert.ok(line.includes('`devswarm.js correct <id>`'));
});

// ---- child activity (summary / broadcast) refreshes the progress clock -----
// Field report: a child posted ~10 heartbeat --summary / broadcast updates
// during a long run but the roster read "STRAYING: stall+burn, progress 1h ago"
// because only `--step` moved step_ts. Activity with NEW text now counts;
// an identical repeat (a looping child) does not.

test('activity: heartbeat --summary with new text refreshes stall + finish label; identical repeats do not', () => {
  const home = tmpHome();
  try {
    const c = { home, env: ENV, cwd: os.tmpdir() };
    const t0 = 1000 * MIN;
    cli.run(['plan', 'set', 'ch-act', '--steps', '1. a\n2. b\n3. c'], Object.assign({}, c, { now: t0 }));
    cli.run(['heartbeat', 'ch-act', '--step', '1', '--status', 'doing'], Object.assign({}, c, { now: t0 }));
    const d = { id: 'ch-act', worktreePath: null };
    const now = t0 + 45 * MIN;
    const stalled = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps: noJev });
    assert.deepStrictEqual(stalled.signals.map((s) => s.signal), ['stall'], 'control: no activity -> stall');

    cli.run(['heartbeat', 'ch-act', '--summary', 'reading the parser'], Object.assign({}, c, { now: now - 5 * MIN }));
    const fresh = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps: noJev });
    assert.ok(!fresh.signals.some((s) => s.signal === 'stall'), 'a new summary 5m ago is progress: ' + JSON.stringify(fresh.signals));
    const plan = planLib.findPlan(home, { id: 'ch-act' }).plan;
    assert.match(planLib.finishLabel(plan, now), /progress 5m ago/);

    // Looping child: the SAME summary again 40m later does not refresh.
    cli.run(['heartbeat', 'ch-act', '--summary', 'Reading the  parser'], Object.assign({}, c, { now: now + 35 * MIN }));
    const later = now + 40 * MIN;
    const loop = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now: later, deps: noJev });
    assert.ok(loop.signals.some((s) => s.signal === 'stall'), 'identical repeat -> still stalled: ' + JSON.stringify(loop.signals));
  } finally { rm(home); }
});

test('activity: a broadcast send from a child with a plan counts as progress', () => {
  const home = tmpHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sup-repo-'));
  try {
    cp.spawnSync('git', ['init', '-q', repo], { env: GIT_ENV });
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
    const id = inst.primaryWorkspaceId(inst.resolveWorktree(repo));
    const t0 = Date.now() - 200 * MIN;
    cli.run(['plan', 'set', id, '--steps', '1. a\n2. b'], { home, env: ENV, cwd: repo, now: t0 });
    const s = cli.run(['send', '--broadcast', '--message', 'phase 2 of the loop done'], { home, backend: 'journal', env: ENV, cwd: repo, now: t0 + 150 * MIN });
    assert.strictEqual(s.result.ok, true, JSON.stringify(s.result));
    const plan = planLib.findPlan(home, { id }).plan;
    assert.strictEqual(plan.activity_ts, t0 + 150 * MIN);
    assert.match(planLib.finishLabel(plan, t0 + 160 * MIN), /progress 10m ago/);
  } finally { rm(home); rm(repo); }
});

test('regression: a done-reported child is awaiting its parent, not stall/burn; a new step re-enables', () => {
  const home = tmpHome();
  try {
    seed(home, 'ch-done', ['read', 'fix', 'test'], (p, now) => { planLib.applyStep(p, 2, 'doing', now - 200 * MIN); });
    const d = { id: 'ch-done', worktreePath: null };
    const now = Date.now();
    const usage = { sinceStep: 9e6, markTs: now - 200 * MIN, closed: null };
    const deps = Object.assign({}, noJev, { tokenUsage: () => usage });
    const before = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now, deps });
    assert.deepStrictEqual(before.signals.map((s) => s.signal).sort(), ['burn', 'stall'], 'control: straying without the done report');
    const plan = planLib.findPlan(home, { id: 'ch-done' }).plan;
    plan.done_reported_at = now - 60 * MIN;
    planLib.savePlan(home, 'ch-done', plan);
    const after = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now: now + 5 * MIN, deps });
    assert.deepStrictEqual(after.signals, [], 'done child: no stall/burn');
    assert.match(planLib.finishLabel(planLib.findPlan(home, { id: 'ch-done' }).plan, now), /awaiting Primary/);
    const fresh = planLib.findPlan(home, { id: 'ch-done' }).plan;
    planLib.applyStep(fresh, 3, 'doing', now + 6 * MIN);
    assert.strictEqual(fresh.done_reported_at, undefined, 'a new step lifts the hold');
    planLib.savePlan(home, 'ch-done', fresh);
    const again = sup.evaluateChild(d, { status: 'alive' }, { home, env: ENV, now: now + 300 * MIN, deps });
    assert.ok(again.signals.length > 0, 'supervision resumes after new work');
  } finally { rm(home); }
});
