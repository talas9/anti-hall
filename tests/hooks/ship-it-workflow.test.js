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
const SRC_RAW = fs.readFileSync(SRC_PATH, 'utf8');
// The Workflow runtime REQUIRES `export const meta` as the first statement, but
// `export` is illegal inside the async-function wrapper used for vm parsing, so we
// strip the keyword exactly the way the runtime treats the body (mirrors
// deadly-loop-workflow.test.js). SRC_RAW keeps the export for the static assertion.
const SRC = SRC_RAW.replace(/^export const meta/m, 'const meta');

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

test('Reviewer tries Fable first when args.fableAvailable=true (RE-ENABLED, 2026-07-12) and stops on success', async () => {
  const reviewerModels = [];
  const { promise, calls } = runStubbed(plan({ fableAvailable: true }), (brief, opts, def) => {
    if (opts && /^phase1:reviewer/.test(opts.label || '')) {
      reviewerModels.push(opts.model);
    }
    return def;
  });
  const out = await promise;
  assert.ok(out.phases.phase1.review);
  assert.deepStrictEqual(reviewerModels, ['fable'], 'fable must be tried first and succeed with no further fallback');
  assert.ok(calls.agents.some((c) => c.opts && c.opts.model === 'fable'), 'expected an agent() call requesting model:fable');
});

test('Reviewer falls back Fable -> Sonnet 5 -> Opus when each seat in turn returns null', async () => {
  const reviewerModels = [];
  const { promise, calls } = runStubbed(plan({ fableAvailable: true }), (brief, opts, def) => {
    if (opts && /^phase1:reviewer/.test(opts.label || '')) {
      reviewerModels.push(opts.model);
      if (opts.model === 'fable' || opts.model === 'sonnet') return null;
    }
    return def;
  });
  const out = await promise;
  assert.ok(out.phases.phase1.review);
  assert.deepStrictEqual(reviewerModels, ['fable', 'sonnet', 'opus'], 'expected the full Fable -> Sonnet 5 -> Opus fallback chain');
  assert.ok(calls.logs.some((l) => /Fable Reviewer unavailable/.test(l)));
  assert.ok(calls.logs.some((l) => /falling back to Opus Reviewer/.test(l)));
});

test('Reviewer stays on Sonnet 5 -> Opus (no Fable attempt) when args.fableAvailable is not true', async () => {
  const reviewerModels = [];
  const { promise, calls } = runStubbed(plan({ fableAvailable: false }), (brief, opts, def) => {
    if (opts && /^phase1:reviewer/.test(opts.label || '')) {
      reviewerModels.push(opts.model);
      if (opts.model === 'sonnet') return null;
    }
    return def;
  });
  const out = await promise;
  assert.ok(out.phases.phase1.review);
  assert.deepStrictEqual(reviewerModels, ['sonnet', 'opus'], 'fable must not be attempted when fableAvailable is not true');
  assert.ok(!calls.agents.some((c) => c.opts && c.opts.model === 'fable'), 'no agent() call should request model:fable when fableAvailable is falsy');
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

test('build effort: defaults to medium (Codex) when phase does not specify phase.effort', async () => {
  const { promise, calls } = runStubbed(plan(), undefined);
  await promise;
  const buildCall = calls.agents.find((c) => c.opts && c.opts.label === 'phase1');
  assert.ok(buildCall, 'expected a build agent() call labeled exactly "phase1"');
  assert.strictEqual(buildCall.opts.effort, 'medium');
});

test('build effort: defaults to high on the Sonnet-5-fallback branch when phase does not specify phase.effort', async () => {
  const { promise, calls } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && opts.label === 'phase1' && opts.agentType === 'codex:codex-rescue') return null; // force Sonnet 5 build fallback
    return def;
  });
  await promise;
  const fallbackCall = calls.agents.find((c) => c.opts && c.opts.label === 'phase1(sonnet-fallback)');
  assert.ok(fallbackCall, 'expected a build agent() call labeled "phase1(sonnet-fallback)"');
  assert.strictEqual(fallbackCall.opts.effort, 'high');
});

test('build effort: phase.effort override is respected on the Codex-primary branch', async () => {
  const hardRiskPlan = {
    parallelGroups: [[{
      label: 'phase1',
      prompt: 'edit a.js',
      files: ['a.js'],
      effort: 'xhigh',
    }]],
  };
  const { promise, calls } = runStubbed(hardRiskPlan, undefined);
  await promise;
  const buildCall = calls.agents.find((c) => c.opts && c.opts.label === 'phase1');
  assert.ok(buildCall);
  assert.strictEqual(buildCall.opts.effort, 'xhigh');
});

test('build effort: phase.effort override is respected on the Sonnet-5-fallback branch', async () => {
  const hardRiskPlan = {
    parallelGroups: [[{
      label: 'phase1',
      prompt: 'edit a.js',
      files: ['a.js'],
      effort: 'xhigh',
    }]],
  };
  const { promise, calls } = runStubbed(hardRiskPlan, (brief, opts, def) => {
    if (opts && opts.label === 'phase1' && opts.agentType === 'codex:codex-rescue') return null; // force Sonnet 5 build fallback
    return def;
  });
  await promise;
  const fallbackCall = calls.agents.find((c) => c.opts && c.opts.label === 'phase1(sonnet-fallback)');
  assert.ok(fallbackCall);
  assert.strictEqual(fallbackCall.opts.effort, 'xhigh');
});

// ---- FIX 1: `export const meta` must be the first non-comment statement --------
test('FIX1: `export const meta` is the first non-comment statement (Workflow runtime contract)', () => {
  // The Workflow runtime rejects a script whose first statement is not a pure
  // `export const meta = {...}` literal (probe P8, deadly-loop.workflow.js:63). Strip
  // leading line comments + blank lines and assert the first real statement is the export.
  const firstStmt = SRC_RAW
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line) && line.trim() !== '')
    .join('\n')
    .trimStart();
  assert.ok(/^export const meta = \{/.test(firstStmt),
    'first non-comment statement must be `export const meta = {…}` (Workflow runtime rejects otherwise)');
});

test('FIX1: meta is a pure literal with name/description + a non-empty phases array', () => {
  assert.match(SRC_RAW, /^export const meta = \{/m,
    'workflow must declare `export const meta` (Workflow runtime rejects non-export form)');
  // Extract and evaluate the meta literal (no vars/calls/spreads => safe to eval).
  // Anchor to line start (`^`, m flag) so the doc comment's `\`export const meta = {...}\``
  // prose is not matched — only the real statement (export stripped to `const meta`).
  const m = SRC.match(/^const meta = (\{[\s\S]*?\n\});/m);
  assert.ok(m, 'meta literal not found / not terminated by `};`');
  const metaVal = vm.runInNewContext('(' + m[1] + ')');
  assert.strictEqual(typeof metaVal.name, 'string');
  assert.ok(metaVal.name.length > 0);
  assert.strictEqual(typeof metaVal.description, 'string');
  assert.ok(metaVal.description.length > 0);
  assert.ok(Array.isArray(metaVal.phases) && metaVal.phases.length > 0, 'phases must be a non-empty array');
  for (const p of metaVal.phases) {
    assert.strictEqual(typeof p.title, 'string');
    assert.strictEqual(typeof p.detail, 'string');
  }
});

// ---- FIX 2: convergence gate tracks NEW P0 OR NEW P1 --------------------------
test('FIX2: VERDICT_SCHEMA requires newP1 alongside newP0', async () => {
  const { promise, calls } = runStubbed(plan(), undefined);
  await promise;
  const reviewerCall = calls.agents.find((c) => c.opts && /reviewer/.test(c.opts.label || ''));
  assert.ok(reviewerCall, 'expected a reviewer agent() call');
  assert.ok(reviewerCall.opts.schema.required.includes('newP0'), 'schema must still require newP0');
  assert.ok(reviewerCall.opts.schema.required.includes('newP1'), 'schema must now also require newP1');
  assert.ok(reviewerCall.opts.schema.properties.newP1, 'schema must define a newP1 property');
});

test('FIX2: a phase with only NEW P1s (newP0:0) is NOT converged — the fix-wave loop must still trigger', async () => {
  const { promise } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && /^phase1:auditor/.test(opts.label || '')) {
      return { verdict: 'fix_needed', newP0: 0, newP1: 2, summary: 'two new P1s' };
    }
    return def;
  });
  const out = await promise;
  assert.ok(out.phases.phase1.gate, 'phase result must carry a mechanical gate summary');
  assert.strictEqual(out.phases.phase1.gate.newP0, 0);
  assert.strictEqual(out.phases.phase1.gate.newP1, 2);
  assert.strictEqual(out.phases.phase1.gate.converged, false,
    'newP1>0 with newP0:0 must still require a fix wave (gate not converged)');
});

test('FIX2: gate converges only when BOTH newP0 and newP1 are zero across the trio', async () => {
  const { promise } = runStubbed(plan(), undefined); // all seats report newP0:0, newP1 absent => 0
  const out = await promise;
  assert.strictEqual(out.phases.phase1.gate.newP0, 0);
  assert.strictEqual(out.phases.phase1.gate.newP1, 0);
  assert.strictEqual(out.phases.phase1.gate.converged, true);
});

// ---- FIX 3: Codex-implemented ⇒ Critic ≠ Codex (implementer≠reviewer) ---------
test('FIX3: Codex-implemented phase ⇒ Critic is NOT Codex (cross-model self-review guard)', async () => {
  const criticCalls = [];
  const { promise, calls } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && /:critic/.test(opts.label || '')) criticCalls.push(opts);
    return def;
  });
  const out = await promise;
  assert.strictEqual(out.phases.phase1.build.implementerModel, 'codex', 'default path builds with Codex');
  assert.ok(!calls.agents.some((c) => c.opts && /:critic/.test(c.opts.label || '') &&
    c.opts.agentType === 'codex:codex-rescue'),
    'Codex built the phase, so NO Codex Critic may review it');
  assert.ok(criticCalls.some((o) => o.model === 'opus'), 'Critic must be seated as Opus when Codex implemented');
  assert.ok(calls.logs.some((l) => /Critic skipping Codex.*cross-model self-review guard/.test(l)),
    'guard must log the Codex-Critic skip');
});

test('FIX3: Sonnet-built phase (Codex unavailable) ⇒ the Codex Critic is allowed and runs', async () => {
  const { promise, calls } = runStubbed(plan(), (brief, opts, def) => {
    if (opts && opts.label === 'phase1' && opts.agentType === 'codex:codex-rescue') return null; // Codex build fails
    return def;
  });
  const out = await promise;
  assert.strictEqual(out.phases.phase1.build.implementerModel, 'sonnet');
  assert.ok(calls.agents.some((c) => c.opts && c.opts.label === 'phase1:critic' &&
    c.opts.agentType === 'codex:codex-rescue'),
    'Sonnet built the phase, so the Codex Critic is not a self-review and should run');
});

test('determinism: no Date.now/Math.random/argless new Date anywhere in ship-it.workflow.js (code, not the doc comment describing the rule)', () => {
  // Strip line comments first — the file's own header documents the rule in prose
  // ("// DETERMINISM: no Date.now() / Math.random() / argless new Date()."), which would
  // otherwise false-positive against a raw-text scan. Normalize CRLF -> LF first: on a
  // Windows checkout each split line keeps a trailing \r, and since `.` never matches a
  // line terminator, `\/\/.*$` can't reach the true end of that line — the strip silently
  // no-ops and the doc-comment's literal "Date.now()" text survives into codeOnly.
  const codeOnly = SRC.replace(/\r\n/g, '\n').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/Date\.now\s*\(/.test(codeOnly), 'Date.now() found in code — breaks workflow determinism');
  assert.ok(!/Math\.random\s*\(/.test(codeOnly), 'Math.random() found in code — breaks workflow determinism');
  assert.ok(!/new Date\(\s*\)/.test(codeOnly), 'argless new Date() found in code — breaks workflow determinism');
});
