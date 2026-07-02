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
