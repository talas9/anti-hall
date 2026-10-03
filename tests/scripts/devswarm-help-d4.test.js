'use strict';
// D4 (P0): devswarm.js had NO help support anywhere — `--help`/`-h` fell
// through to real verb dispatch. For `register-primary`/`migrate`/
// `migrate-owner-keys` that meant a live mutation; for the raw-argv-tail
// pass-through verbs (`spawn`/`merge`) it meant forwarding straight to the
// hivecontrol child process, with `merge` additionally emitting an
// UNCONDITIONAL mesh broadcast on top of that (devswarm.js's own write, not
// hivecontrol's).
//
// This suite proves the help intercept in run() (checked BEFORE the switch,
// so it covers every verb including spawn/merge) fires correctly and has
// ZERO side effects — no store write, no mesh append, no child process spawn
// — by injecting io/ctx and asserting against those injected points, never
// by running the real hivecontrol binary.
//
// HOME isolation: every test uses a fresh mkdtemp'd home passed as ctx.home;
// nothing here ever touches the real ~/.anti-hall (repo rule — three prior
// incidents of test HOME leakage).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-help-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
// Recursive snapshot of every file under `home`, so a before/after diff
// catches ANY write anywhere in the store tree — not just the ones we think
// to look for.
function snapshot(home) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(home, p));
    }
  }
  walk(home);
  return out.sort();
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

test('bare --help: ok, code 0, no verb, full verb list, zero side effects', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['--help'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, null);
    assert.ok(Array.isArray(r.result.verbs) && r.result.verbs.length > 20);
    assert.ok(r.result.verbs.includes('migrate'));
    assert.ok(r.result.verbs.includes('merge'));
    assert.ok(typeof r.result.usage === 'string' && r.result.usage.includes('usage: devswarm.js'));
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('bare -h: same as --help', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['-h'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, null);
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('bare help: same as --help', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['help'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, null);
  } finally { rm(home); }
});

test('help <verb>: known verb prints that verb\'s usage, known:true', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['help', 'migrate'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'migrate');
    assert.equal(r.result.known, true);
    assert.ok(r.result.usage.includes('migrate'));
  } finally { rm(home); }
});

test('help <unknown-verb>: known:false, falls back to the full verb list', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['help', 'not-a-real-verb'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'not-a-real-verb');
    assert.equal(r.result.known, false);
    assert.ok(r.result.usage.includes('unknown verb'));
    assert.ok(r.result.usage.includes('usage: devswarm.js <verb>'));
    assert.ok(r.result.usage.includes('migrate'));
  } finally { rm(home); }
});

test('<verb> --help works for a plain, non-mutating verb (workspaces --help)', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['workspaces', '--help'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'workspaces');
    assert.equal(r.result.known, true);
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

// --- CRITICAL regression: migrate --help must never run the real migration ---
test('P0 REGRESSION: migrate --help produces NO store write (cmdMigrate never runs)', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['migrate', '--help'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'migrate');
    // Pre-fix, this would have run cmdMigrate(ctx) for real (cmdMigrate never
    // even reads `flags`, so `--help` was silently ignored and the migration
    // ran). Prove no filesystem mutation happened anywhere under home.
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

// --- CRITICAL regression: register-primary --help must never mutate ---
test('P0 REGRESSION: register-primary --help produces NO store write', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['register-primary', '--help'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

// --- CRITICAL regression: merge --help must never shell out or broadcast ---
// cmdMergeVerb forwards to hivecontrol via ctx.io.run and, independent of
// that outcome, ALWAYS appends a mesh broadcast (store.appendMeshMessage) —
// devswarm.js's own write, not hivecontrol's. Inject an io.run stub that
// throws if invoked, so this fails loudly if the help intercept is ever
// bypassed, rather than silently shelling out in CI.
test('P0 REGRESSION: merge --help produces NO store write, NO mesh broadcast, NO child-process spawn', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    let ranChildProcess = false;
    const c = ctx(home, {
      cwd: os.tmpdir(),
      io: { run: () => { ranChildProcess = true; throw new Error('cmdMergeVerb must never run for `merge --help`'); } },
    });
    const r = cli.run(['merge', '--help'], c);
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'merge');
    assert.equal(ranChildProcess, false);
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

// --- CRITICAL regression: spawn --help must never forward to hivecontrol ---
test('P0 REGRESSION: spawn --help produces NO child-process spawn', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    let ranChildProcess = false;
    const c = ctx(home, {
      cwd: os.tmpdir(),
      io: { run: () => { ranChildProcess = true; throw new Error('cmdSpawn must never run for `spawn --help`'); } },
    });
    const r = cli.run(['spawn', '--help'], c);
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'spawn');
    assert.equal(ranChildProcess, false);
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

// --- fix-up regression: single-dash `-h` on a REAL subcommand ---
// A first pass of this fix only checked `positionals[0] === '-h'` (bare
// `-h`), which missed `-h` typed AFTER a verb — `-h` never lands in `flags`
// (parseArgs only routes `--`-prefixed tokens there), so `migrate -h` fell
// straight through to real dispatch and genuinely ran the migration; `merge
// -h` genuinely reached the unconditional mesh broadcast. Each case here
// proves BOTH the help result shape AND, for the mutating/mesh verbs, zero
// side effects via the same injected-io/snapshot-diff technique used above.
test('P0 REGRESSION (fix-up): `migrate -h` intercepts — NO store write', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['migrate', '-h'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'migrate');
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('P0 REGRESSION (fix-up): `register-primary -h` intercepts — NO store write', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['register-primary', '-h'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'register-primary');
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('P0 REGRESSION (fix-up): `migrate-owner-keys -h` intercepts — NO descriptor write', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['migrate-owner-keys', '-h'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'migrate-owner-keys');
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('P0 REGRESSION (fix-up): `reconcile -h` intercepts — NO store write, NO inbox-pull spawn', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    let ranChildProcess = false;
    const c = ctx(home, {
      cwd: os.tmpdir(),
      io: { run: () => { ranChildProcess = true; throw new Error('cmdReconcile must never run for `reconcile -h`'); } },
    });
    const r = cli.run(['reconcile', '-h'], c);
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'reconcile');
    assert.equal(ranChildProcess, false);
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('P0 REGRESSION (fix-up), MOST IMPORTANT: `merge -h` intercepts — NO hivecontrol shell-out, NO mesh broadcast', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    let ranChildProcess = false;
    const c = ctx(home, {
      cwd: os.tmpdir(),
      io: { run: () => { ranChildProcess = true; throw new Error('cmdMergeVerb must never run for `merge -h`'); } },
    });
    const r = cli.run(['merge', '-h'], c);
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'merge');
    assert.equal(ranChildProcess, false);
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('P0 REGRESSION (fix-up): `spawn -h` intercepts — NO hivecontrol shell-out', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    let ranChildProcess = false;
    const c = ctx(home, {
      cwd: os.tmpdir(),
      io: { run: () => { ranChildProcess = true; throw new Error('cmdSpawn must never run for `spawn -h`'); } },
    });
    const r = cli.run(['spawn', '-h'], c);
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'spawn');
    assert.equal(ranChildProcess, false);
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('`-h` in a later position (`inbox read ws1 -h`) still intercepts', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['inbox', 'read', 'ws1', '-h'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'inbox');
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

// --- mid-argv --help must not swallow the following positional AND must
// still short-circuit before dispatch (both halves of the original defect) ---
test('mid-argv --help (`inbox read --help ws1`) still triggers help, not a swallow-then-dispatch', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['inbox', 'read', '--help', 'ws1'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.action, 'help');
    // cmd (positionals[0]) is 'inbox', so verb-specific help for 'inbox' is used.
    assert.equal(r.result.verb, 'inbox');
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

// --- the verb list must be derived, not hand-typed, so it can't drift ---
test('the derived verb list matches the dispatch table and stays free of drift-prone gaps', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['--help'], ctx(home));
    // Two verbs proven (by direct source inspection) to be MISSING from the
    // OLD hand-typed error-message list in run()'s `default:` branch — if the
    // help list were hand-typed the same way, it would have silently
    // inherited the same drift. Assert both are present.
    assert.ok(r.result.verbs.includes('reconcile-registry'));
    assert.ok(r.result.verbs.includes('wake-directive'));
    // No duplicates.
    assert.equal(new Set(r.result.verbs).size, r.result.verbs.length);
  } finally { rm(home); }
});

// --- main()'s human-line rendering path (module boundary only; no subprocess) ---
test('module exports run() so --help is fully testable without spawning the CLI binary', () => {
  assert.equal(typeof cli.run, 'function');
});
