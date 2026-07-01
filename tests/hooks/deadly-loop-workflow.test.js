'use strict';
// Static checks for skills/deadly-loop/references/deadly-loop.workflow.js.
//
// This is a Dynamic-Workflow template, NOT a Node module — it ends in a bare
// `return main();` and references runtime globals (agent/parallel/phase/log/args).
// So we do NOT require() it. We read the source and (a) validate it PARSES under a
// stubbed Workflow-dialect harness, (b) extract the `meta` literal, (c) assert the
// determinism / no-versioned-model / no-fs invariants by source inspection.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_PATH = path.join(
  __dirname, '..', '..',
  'plugins', 'anti-hall', 'skills', 'deadly-loop', 'references', 'deadly-loop.workflow.js',
);
const SRC_RAW = fs.readFileSync(SRC_PATH, 'utf8');

// The Workflow runtime REQUIRES `export const meta` as the script's first
// statement (verified live 2026-06-10: the tool rejects the non-export form).
// `export` is illegal inside the async-function wrapper used for vm parsing, so
// the harness strips the keyword exactly the way the runtime treats the body.
const SRC = SRC_RAW.replace(/^export const meta/m, 'const meta');

// CODE-only view: strip line + block comments so the forbidden-API scan inspects
// executable code, not the determinism header prose (which names the banned APIs
// precisely so a reader knows what is forbidden).
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// Wrap the template body in an async function so the trailing `return main();` is
// legal, then run it under a sandbox that stubs every Workflow global. agent() and
// parallel() return inert stubs so no real spawn happens; we only prove it PARSES
// and runs to a structured return without throwing.
function runStubbed(argsObj, agentImpl) {
  const calls = { agents: [], phases: [], logs: [] };
  // Minimal verdict-shaped object so Phase 3 logic has something to chew.
  const defaultReport = () => ({
    verdict: 'GO', checkedSHA: argsObj.targetSHA, checkedBranch: argsObj.branch,
    findings: [], packSummary: 'stub', packText: 'stub-pack', responses: [],
  });
  const stubAgent = async (brief, opts) => {
    calls.agents.push({ brief, opts });
    // Optional per-test agent override: (brief, opts, defaultReport) => report.
    if (agentImpl) return agentImpl(brief, opts, defaultReport());
    return defaultReport();
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
  const wrapped = '(async () => {\n' + SRC + '\n})()';
  const script = new vm.Script(wrapped, { filename: 'deadly-loop.workflow.js' });
  const ctx = vm.createContext(sandbox);
  return { promise: script.runInContext(ctx), calls };
}

test('source parses under the stubbed Workflow harness (vm.Script compiles)', () => {
  // node --check rejects the `return` at top level (ESM-ish template), so the
  // authoritative parse check is compiling the wrapped body in a vm. This also
  // exercises that `meta`, the schemas, and all helpers are syntactically valid.
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new
    new vm.Script('(async () => {\n' + SRC + '\n})()', { filename: 'parse-check.js' });
  });
});

test('meta literal present with required fields + phases match meta', async () => {
  // Extract `meta` by evaluating only its declaration in a tiny sandbox.
  // Runtime contract (live-verified): export form, first statement in the file.
  assert.match(SRC_RAW, /^export const meta = \{/m,
    'workflow must declare `export const meta` (Workflow runtime rejects non-export form)');
  const m = SRC.match(/const meta = (\{[\s\S]*?\n\});/) ||
    SRC.match(/const meta = (\{[\s\S]*?\n\};)/);
  if (m) m[1] = m[1].replace(/;$/, '');
  assert.ok(m, 'meta literal not found');
  const metaVal = vm.runInNewContext('(' + m[1] + ')');
  assert.strictEqual(metaVal.name, 'deadly-loop-round');
  assert.strictEqual(typeof metaVal.description, 'string');
  assert.ok(metaVal.description.length > 0);
  // metaVal is built in a separate vm realm, so deepStrictEqual would fail on the
  // cross-realm Array prototype — compare by serialized value instead. Phases are
  // {title, detail} entries (Workflow docs shape); titles must match phase() calls.
  assert.strictEqual(
    JSON.stringify(metaVal.phases.map((p) => p.title)),
    JSON.stringify(['Context', 'Investigate', 'Argue', 'Converge']));
  for (const p of metaVal.phases) assert.strictEqual(typeof p.detail, 'string');
});

test('forbidden runtime-nondeterminism + node APIs absent', () => {
  // Determinism header invariants (mirror ship-it.workflow.js): no wall-clock /
  // randomness, no require/process, no fs.
  assert.ok(!/Date\.now\s*\(/.test(CODE), 'Date.now() must not appear');
  assert.ok(!/Math\.random\s*\(/.test(CODE), 'Math.random() must not appear');
  assert.ok(!/new Date\s*\(\s*\)/.test(CODE), 'argless new Date() must not appear');
  assert.ok(!/\brequire\s*\(/.test(CODE), 'require() must not appear');
  assert.ok(!/\bprocess\./.test(CODE), 'process.* must not appear');
});

test('MODEL INVARIANT: no versioned model ids anywhere in source', () => {
  // Owner addendum: select latest-at-call-time via tier tokens only; never a
  // versioned id like claude-fable-5 / claude-opus-4-8.
  const versioned = SRC.match(/claude-[a-z]+-\d/g);
  assert.strictEqual(versioned, null,
    'versioned model id(s) found: ' + JSON.stringify(versioned));
});

test('tier tokens + canonical Codex agentType present (latest-at-call-time routing)', () => {
  assert.ok(/model:\s*'sonnet'/.test(SRC), "context agent and reviewer must use model:'sonnet'");
  assert.ok(/model:\s*'opus'/.test(SRC), "auditor must be model:'opus'");
  assert.ok(/agentType:\s*'codex:codex-rescue'/.test(SRC),
    'critic must use the canonical codex:codex-rescue agentType');
});

test('hard-15 backstop refuses to spawn (no agent calls when round > 15)', async () => {
  const { promise, calls } = runStubbed({
    round: 16, targetSHA: 'deadbeef', branch: 'main', scope: 'repo', contextMode: 'initial',
  });
  const out = await promise;
  assert.strictEqual(out.error, 'hard-cap-exceeded');
  assert.strictEqual(calls.agents.length, 0, 'no agents should be spawned past the cap');
});

test('missing args returns a usage error, spawns nothing', async () => {
  // Run with args === undefined (template guards on it).
  const sandbox = {
    args: undefined, budget: {},
    agent: async () => { throw new Error('should not spawn'); },
    parallel: async () => { throw new Error('should not spawn'); },
    pipeline: async () => {}, phase: () => {}, log: () => {},
    console, JSON, Math, Array, Object, isFinite, Promise,
  };
  const out = await new vm.Script('(async () => {\n' + SRC + '\n})()')
    .runInContext(vm.createContext(sandbox));
  assert.ok(typeof out.error === 'string' && /no `args`/.test(out.error));
});

test('one full round runs Context->Investigate->Argue->Converge and returns the verdict shape', async () => {
  const { promise, calls } = runStubbed({
    round: 1, multiplier: 1, targetSHA: 'abc123', branch: 'main', scope: 'whole repo',
    contextMode: 'initial', argue: true,
  });
  const out = await promise;
  // Verdict-summary contract.
  assert.ok(out.verdictSummary && typeof out.verdictSummary === 'object');
  assert.strictEqual(out.verdictSummary.roundsUsed, 1);
  assert.ok(Array.isArray(out.confirmed));
  assert.ok(Array.isArray(out.contested));
  assert.ok(Array.isArray(out.residue));
  assert.ok(Array.isArray(out.seatReports));
  assert.strictEqual(out.seatReports.length, 3, 'trio = 3 seats at multiplier 1');
  // All four phases were announced.
  assert.ok(calls.phases.some((p) => /Context:/.test(p)));
  assert.ok(calls.phases.some((p) => /Investigate:/.test(p)));
  assert.ok(calls.phases.some((p) => /Argue:/.test(p)));
  assert.ok(calls.phases.some((p) => /Converge:/.test(p)));
  // Context agent + Reviewer = sonnet (Sonnet 5); Auditor = opus; Critic = codex:codex-rescue.
  assert.ok(calls.agents.some((c) => c.opts && c.opts.model === 'sonnet'));
  assert.ok(calls.agents.some((c) => c.opts && c.opts.model === 'opus'));
  assert.ok(calls.agents.some((c) => c.opts && c.opts.agentType === 'codex:codex-rescue'));
});

test('multiplier scales the formation (double = 6 debate seats)', async () => {
  const { promise } = runStubbed({
    round: 2, multiplier: 2, targetSHA: 'abc123', branch: 'main', scope: 'diff',
    contextMode: 'incremental', argue: false,
  });
  const out = await promise;
  assert.strictEqual(out.seatReports.length, 6, 'double trio = 6 seats');
});

// ---- ADDENDUM C1-5: non-Array findings => 'missing-findings-array' drift ----
test("C1-5: report with non-Array findings drifts as 'missing-findings-array' and respawns", async () => {
  const A = { round: 1, multiplier: 1, targetSHA: 'abc123', branch: 'main',
    scope: 'whole repo', contextMode: 'initial', argue: false };
  let firstReviewerCall = true;
  const { promise, calls } = runStubbed(A, (brief, opts, def) => {
    if (opts && opts.label === 'round-1:reviewer-1' && firstReviewerCall) {
      firstReviewerCall = false;
      // verdict GO but findings is NOT an array (omitted) => must be drift.
      return { verdict: 'GO', checkedSHA: A.targetSHA, checkedBranch: A.branch };
    }
    return def;
  });
  const out = await promise;
  assert.ok(calls.logs.some((l) => /missing-findings-array/.test(l)),
    'drift log must name missing-findings-array');
  assert.ok(calls.agents.some((c) => c.opts && c.opts.label === 'round-1:reviewer-1:respawn'),
    'drifted seat must be respawned once');
  assert.strictEqual(out.verdictSummary.degraded, false,
    'clean respawn report means the round is not degraded');
});

// ---- ADDENDUM C1-3: corroboration threshold (multiplier > 1 ? 2 : 1) --------
const F1 = { id: 'F1', severity: 'P2', file: 'x.js', line: 5, category: 'bug',
  claim: 'stale guard', evidence: 'x.js:5' };

// Agent impl: only reviewer-1 reports F1; `corroborators` argue-seats corroborate it.
function corroborationImpl(A, corroborators) {
  return (brief, opts, def) => {
    const label = (opts && opts.label) || '';
    if (/:argue$/.test(label)) {
      const seat = label.replace(/:argue$/, '');
      return {
        responses: corroborators.includes(seat)
          ? [{ findingId: 'F1', stance: 'corroborate', evidence: 'x.js:5' }] : [],
      };
    }
    if (label === 'round-1:reviewer-1') return { ...def, findings: [F1] };
    return def;
  };
}

test('C1-3: multiplier 1 — a single corroboration confirms (threshold 1)', async () => {
  const A = { round: 1, multiplier: 1, targetSHA: 'abc123', branch: 'main',
    scope: 'whole repo', contextMode: 'initial', argue: true };
  const { promise } = runStubbed(A, corroborationImpl(A, ['round-1:auditor-1']));
  const out = await promise;
  assert.strictEqual(out.confirmed.length, 1, 'one corroboration confirms at trio scale');
  assert.strictEqual(out.residue.length, 0);
  assert.strictEqual(out.confirmed[0].stances.corroborated, 1);
});

test('C1-3: multiplier 2 — one corroboration is residue, two confirm (threshold 2)', async () => {
  const A = { round: 1, multiplier: 2, targetSHA: 'abc123', branch: 'main',
    scope: 'whole repo', contextMode: 'initial', argue: true };
  // One corroboration: too cheap with duplicated seats => residue.
  const one = await runStubbed(A, corroborationImpl(A, ['round-1:auditor-1'])).promise;
  assert.strictEqual(one.confirmed.length, 0, 'single corroboration must NOT confirm at multiplier 2');
  assert.strictEqual(one.residue.length, 1);
  // Two corroborations: meets the threshold => confirmed.
  const two = await runStubbed(A,
    corroborationImpl(A, ['round-1:auditor-1', 'round-1:auditor-2'])).promise;
  assert.strictEqual(two.confirmed.length, 1, 'two corroborations confirm at multiplier 2');
  assert.strictEqual(two.confirmed[0].stances.corroborated, 2);
});

test('model-routing-guard: every seat brief template contains at least one complex token', () => {
  // Read the guard's COMPLEX list directly from the source — never duplicate it here.
  const guardSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'model-routing-guard.js'),
    'utf8',
  );
  // Extract the COMPLEX array literal from the guard source.
  const complexMatch = guardSrc.match(/const COMPLEX = \[([\s\S]*?)\];/);
  assert.ok(complexMatch, 'could not locate COMPLEX array in model-routing-guard.js');
  // Parse the string literals out of the array.
  const complexTokens = [];
  const tokenRe = /'([^']+)'/g;
  let m;
  while ((m = tokenRe.exec(complexMatch[1])) !== null) complexTokens.push(m[1]);
  assert.ok(complexTokens.length > 0, 'COMPLEX token list must not be empty');

  // Tokenize the guard's way: NFKC + lowercase + split on non-word-chars.
  function tokenize(s) {
    let t = s;
    try { t = t.normalize('NFKC'); } catch (_) {}
    t = t.toLowerCase();
    return t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }
  function hasPhrase(tokens, phrase) {
    const parts = phrase.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return tokens.includes(parts[0]);
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      if (parts.every((p, j) => tokens[i + j] === p)) return true;
    }
    return false;
  }
  function briefHasComplex(brief) {
    const toks = tokenize(brief);
    return complexTokens.some((ct) => hasPhrase(toks, ct));
  }

  // Build sample briefs using the workflow's own functions by running the stubbed harness
  // and capturing the brief strings passed to agent().
  const { calls, promise: p } = runStubbed({
    round: 1, multiplier: 1, targetSHA: 'sha1', branch: 'main', scope: 'run tests',
    contextMode: 'initial', argue: true,
  });
  return p.then(() => {
    // Separate context-pack agent from debate seats.
    const debateAgents = calls.agents.filter((c) => c.opts && c.opts.label &&
      /(reviewer|auditor|critic)/.test(c.opts.label));
    assert.ok(debateAgents.length > 0, 'expected at least one debate seat agent call');
    for (const c of debateAgents) {
      assert.ok(
        briefHasComplex(c.brief),
        'brief for seat ' + JSON.stringify(c.opts) + ' has NO model-routing-guard complex token.\n' +
        'Brief excerpt: ' + c.brief.slice(0, 200),
      );
    }
  });
});
