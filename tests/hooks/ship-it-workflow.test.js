'use strict';
// Static/runtime checks for skills/ship-it/references/ship-it.workflow.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_PATH = path.join(
  __dirname, '..', '..',
  'plugins', 'anti-hall', 'skills', 'ship-it', 'references', 'ship-it.workflow.js',
);
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

function runStubbed(argsObj, agentImpl) {
  const calls = { agents: [], phases: [], logs: [] };
  const defaultFor = (opts) => {
    const props = opts && opts.schema && opts.schema.properties ? opts.schema.properties : {};
    if (props.status) return { label: opts.label, status: 'pass', evidence: 'stub' };
    return { verdict: 'converged', newP0: 0, summary: 'stub' };
  };
  const stubAgent = async (brief, opts) => {
    calls.agents.push({ brief, opts });
    const def = defaultFor(opts);
    if (agentImpl) return agentImpl(brief, opts, def);
    return def;
  };
  const stubParallel = async (tasks) => Promise.all(tasks.map((t) => t()));
  const sandbox = {
    args: argsObj,
    budget: {},
    agent: stubAgent,
    parallel: stubParallel,
    pipeline: async (tasks) => { let v; for (const t of tasks) v = await t(); return v; },
    phase: (s) => calls.phases.push(s),
    log: (s) => calls.logs.push(s),
    console,
    JSON, Math, Array, Object, isFinite, Promise,
  };
  const script = new vm.Script('(async () => {\n' + SRC + '\n})()', {
    filename: 'ship-it.workflow.js',
  });
  return { promise: script.runInContext(vm.createContext(sandbox)), calls };
}

function plan(extra = {}) {
  return {
    ...extra,
    parallelGroups: [[{
      label: 'phase1',
      prompt: 'edit a.js',
      files: ['a.js'],
    }]],
  };
}

test('default Reviewer path remains Sonnet 5 -> Opus fallback', async () => {
  const reviewerModels = [];
  const { promise } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && /^phase1:reviewer/.test(opts.label || '')) {
      reviewerModels.push(opts.model);
      if (opts.model === 'sonnet') return null;
    }
    return def;
  });
  const out = await promise;
  assert.ok(out.phases.phase1.review);
  assert.deepStrictEqual(reviewerModels, ['sonnet', 'opus']);
});

test('Reviewer skips Fable even when args.fableAvailable=true (policy-disabled), goes Sonnet 5 then Opus', async () => {
  const reviewerModels = [];
  const { promise, calls } = runStubbed(plan({ fableAvailable: true }), (brief, opts, def) => {
    if (opts && /^phase1:reviewer/.test(opts.label || '')) {
      reviewerModels.push(opts.model);
      if (opts.model === 'sonnet') return null;
    }
    return def;
  });
  const out = await promise;
  assert.ok(out.phases.phase1.review);
  assert.deepStrictEqual(reviewerModels, ['sonnet', 'opus'], 'fable must never be attempted, even with fableAvailable=true');
  assert.ok(!calls.agents.some((c) => c.opts && c.opts.model === 'fable'), 'no agent() call should ever request model:fable');
  assert.ok(calls.logs.some((l) => /falling back to Opus Reviewer/.test(l)));
});

test('B5: build seat tries Codex first; on success implementerModel is "codex"', async () => {
  const { promise, calls } = runStubbed(plan(), undefined);
  const out = await promise;
  assert.strictEqual(out.phases.phase1.build.implementerModel, 'codex');
  const buildCall = calls.agents.find((c) => c.opts && c.opts.label === 'phase1');
  assert.ok(buildCall, 'expected a build agent() call labeled exactly "phase1"');
  assert.strictEqual(buildCall.opts.agentType, 'codex:codex-rescue');
});

test('B5: build seat falls back to Sonnet 5 when Codex is unavailable, and marks implementerModel accordingly', async () => {
  const { promise, calls } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && opts.label === 'phase1' && opts.agentType === 'codex:codex-rescue') return null; // Codex build fails
    return def;
  });
  const out = await promise;
  assert.strictEqual(out.phases.phase1.build.implementerModel, 'sonnet');
  const fallbackCall = calls.agents.find((c) => c.opts && c.opts.label === 'phase1(sonnet-fallback)');
  assert.ok(fallbackCall, 'expected a build agent() call labeled "phase1(sonnet-fallback)"');
  assert.strictEqual(fallbackCall.opts.model, 'sonnet');
  assert.ok(calls.logs.some((l) => /Codex build unavailable/.test(l)));
});

test('B5: RESULT_SCHEMA requires implementerModel with enum [codex, sonnet]', async () => {
  const { promise, calls } = runStubbed(plan(), undefined);
  await promise;
  const buildCall = calls.agents.find((c) => c.opts && c.opts.label === 'phase1');
  assert.ok(buildCall.opts.schema.required.includes('implementerModel'));
  // Array.from re-materializes the vm-realm array in this realm — plain deepStrictEqual on a
  // cross-realm array fails ("same structure but not reference-equal") even with identical
  // contents, since Node's assert checks the array's prototype/constructor realm too.
  assert.deepStrictEqual(Array.from(buildCall.opts.schema.properties.implementerModel.enum), ['codex', 'sonnet']);
});

test('B5: Reviewer skips its own Sonnet 5 attempt and goes straight to Opus when this phase was built by Sonnet 5 (cross-model self-review guard)', async () => {
  const reviewerModels = [];
  const { promise, calls } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && opts.label === 'phase1' && opts.agentType === 'codex:codex-rescue') return null; // force Sonnet 5 build fallback
    if (opts && /^phase1:reviewer/.test(opts.label || '')) {
      reviewerModels.push(opts.model);
    }
    return def;
  });
  const out = await promise;
  assert.strictEqual(out.phases.phase1.build.implementerModel, 'sonnet');
  assert.ok(out.phases.phase1.review);
  assert.deepStrictEqual(reviewerModels, ['opus'], 'Reviewer must skip Sonnet 5 entirely and go straight to Opus');
  assert.ok(calls.logs.some((l) => /Reviewer skipping Sonnet 5.*cross-model self-review guard/.test(l)));
});

test('B5: Reviewer still tries Sonnet 5 normally when Codex built the phase (no self-review conflict)', async () => {
  const reviewerModels = [];
  const { promise } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && /^phase1:reviewer/.test(opts.label || '')) {
      reviewerModels.push(opts.model);
    }
    return def;
  });
  const out = await promise;
  assert.strictEqual(out.phases.phase1.build.implementerModel, 'codex');
  assert.deepStrictEqual(reviewerModels, ['sonnet'], 'Codex built the phase, so Sonnet 5 Reviewer runs normally');
});

test('determinism: no Date.now/Math.random/argless new Date anywhere in ship-it.workflow.js (code, not the doc comment describing the rule)', () => {
  // Strip line comments first — the file's own header documents the rule in prose
  // ("// DETERMINISM: no Date.now() / Math.random() / argless new Date()."), which would
  // otherwise false-positive against a raw-text scan.
  const codeOnly = SRC.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/Date\.now\s*\(/.test(codeOnly), 'Date.now() found in code — breaks workflow determinism');
  assert.ok(!/Math\.random\s*\(/.test(codeOnly), 'Math.random() found in code — breaks workflow determinism');
  assert.ok(!/new Date\(\s*\)/.test(codeOnly), 'argless new Date() found in code — breaks workflow determinism');
});
