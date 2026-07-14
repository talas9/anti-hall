'use strict';
// verify-first-orch (SessionStart) — the ORCHESTRATION DISCIPLINE ruleset, the
// companion to the verify-first FOUNDATION (verify-first-full.js). Exit 0;
// additionalContext = the ORCHESTRATION DISCIPLINE header + rules A-N (and, for a
// DevSwarm Primary ONLY, rule W spliced before rule A).
//
// This hook exists because the combined foundation + orchestration payload was
// ~15.3k chars — over the ~10,000-char per-hook injection cap (which spills the
// overflow to a file). The doctrine is split across two SessionStart hooks, each
// under the cap. This suite is the regression net for the orchestration half:
// every rule label A-N is present, rule L is in its restored ALPHABETICAL slot,
// rule W gates correctly on DevSwarm-Primary, and the whole payload clears the cap.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'verify-first-orch.js';
const CAP = 10000; // per code.claude.com/docs/en/hooks; over this -> spill-to-file

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

const ORCHESTRATION_HEADER = ['ORCHESTRATION DISCIPLINE', 'orchestration discipline header'];
const ORCHESTRATION_LABELS = [
  ['  A. COMMAND DELEGATION', 'rule A (COMMAND DELEGATION)'],
  ['  B.', 'rule B (non-blocking main thread)'],
  ['  C.', 'rule C (drain the list)'],
  ['  D.', 'rule D (bias toward delegation)'],
  ['  E.', 'rule E (inline only atomic)'],
  ['  E2. GRAPHIFY-FIRST', 'rule E2 (GRAPHIFY-FIRST)'],
  ['  F.', 'rule F (parallel agents / noisy off main thread)'],
  ['run_in_background', 'rule F keyword (DEFAULT delegated work to BACKGROUND via run_in_background)'],
  ['to the BACKGROUND', 'rule F keyword (default heavy/long/parallel work to the BACKGROUND)'],
  ['fire-and-forget', 'rule F keyword (never fire-and-forget: drain + verify the backgrounded task)'],
  ['  G. SYNTHESIZE, NEVER RELAY', 'rule G (synthesize, never relay raw subagent output)'],
  ['OUTPUT BUDGET', 'rule G keyword (subagents return tight summaries under an OUTPUT BUDGET)'],
  ['message-context bloat', 'rule G keyword (raw relay is the #1 cause of message-context bloat)'],
  ['5x smaller', 'rule G keyword (structured return MEASURED ~5x smaller than verbose prose)'],
  ['blockers', 'rule G keyword (structured-return schema field: blockers/uncertainty)'],
  ['schema to the Agent', 'rule G keyword (enforce via schema: pass a schema to the Agent/Task tool)'],
  ['  H.', 'rule H (communicate concisely)'],
  ['  I.', 'rule I (watch/babysit agents)'],
  ['  J.', 'rule J (phase statusline)'],
  ['  K. PRESENT FOR SCANNABILITY', 'rule K (PRESENT FOR SCANNABILITY)'],
  ['  L. VERIFY DELEGATED WORK', 'rule L (VERIFY DELEGATED WORK)'],
  ['UNVERIFIED CLAIM', 'rule L keyword (a subagent report is an UNVERIFIED CLAIM)'],
  ['GROUND TRUTH', 'rule L keyword (reconcile against GROUND TRUTH)'],
  ['  M. PREFER SHALLOW+WIDE', 'rule M (shallow+wide, lift nesting into a Workflow)'],
  ['  N. DISTRIBUTE MODELS', 'rule N (distribute models, never all-Opus)'],
];

function assertAll(c, table) {
  for (const [needle, label] of table) {
    assert.ok(c.includes(needle), `DROPPED: ${label} (missing substring: ${JSON.stringify(needle)})`);
  }
}

function sessionStart(env) {
  const h = makeHome();
  try {
    return testHook(
      HOOK,
      { hook_event_name: 'SessionStart', source: 'startup', session_id: 't', cwd: process.cwd() },
      { home: h.home, env, expectJson: true },
    );
  } finally {
    h.cleanup();
  }
}

test('SessionStart -> orchestration header + EVERY rule label A-N intact', () => {
  const r = sessionStart(undefined);
  assert.strictEqual(r.status, 0, 'hook must exit 0');
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart', 'echoes SessionStart event');
  const c = ctx(r);
  assert.ok(c.length > 0, 'additionalContext must be non-empty');
  assert.ok(c.includes(ORCHESTRATION_HEADER[0]), `DROPPED: ${ORCHESTRATION_HEADER[1]}`);
  assertAll(c, ORCHESTRATION_LABELS);
});

test('rule L is restored to ALPHABETICAL order (between K and M, no longer hoisted after A)', () => {
  const c = ctx(sessionStart(undefined));
  const iK = c.indexOf('\n  K.');
  const iL = c.indexOf('\n  L.');
  const iM = c.indexOf('\n  M.');
  const iA = c.indexOf('\n  A.');
  assert.ok(iK > 0 && iL > 0 && iM > 0, 'rules K/L/M must all be present');
  assert.ok(iK < iL && iL < iM, `rule L must sit between K and M (K@${iK} L@${iL} M@${iM})`);
  assert.ok(iL > iA, 'rule L must NOT be hoisted to just after rule A anymore');
});

test('orchestration hook stays under the ~10k cap with headroom (baseline AND primary)', () => {
  const base = ctx(sessionStart(undefined));
  const primary = ctx(sessionStart({ DEVSWARM_REPO_ID: 'repo-x' }));
  for (const [label, c] of [['baseline', base], ['primary', primary]]) {
    assert.ok(c.length <= CAP, `${label} additionalContext ${c.length} > ${CAP} — would spill to file`);
    assert.ok(c.length <= 9000, `${label} additionalContext ${c.length} > 9000 — target headroom breached`);
  }
});

// ---------------------------------------------------------------------------
// DEVSWARM PRIMARY: rule W (the workspace tier). Emitted ONLY for a Primary; a
// CHILD workspace and any non-DevSwarm session get the byte-identical baseline.
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-x' };            // no SOURCE_BRANCH -> Primary
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y' };

test('DEVSWARM PRIMARY: rule W names the WORKSPACE tier, the spawn command, and the failure mode', () => {
  const c = ctx(sessionStart(PRIMARY_ENV));
  assert.ok(c.includes('  W. DEVSWARM PRIMARY'), 'rule W missing for a DevSwarm Primary');
  assert.ok(/CHILD WORKSPACE/.test(c), 'rule W must name the child-workspace tier');
  assert.ok(/NOT a subagent/.test(c), 'rule W must forbid handing workspace-scale work to a subagent');
  assert.ok(/feature\/fix\/deploy/.test(c), 'rule W must state what counts as workspace-scale');
  // Restored (no longer the 76-char cap-squeezed form): the operative spawn command.
  assert.ok(/devswarm\.js spawn <branch> -p/.test(c), 'restored rule W must carry the spawn command');
  // Placed inside the block, before rule A (primacy).
  assert.ok(c.indexOf('  W. DEVSWARM PRIMARY') > c.indexOf('ORCHESTRATION DISCIPLINE'),
    'rule W must live inside the ORCHESTRATION DISCIPLINE block');
  assert.ok(c.indexOf('  W. DEVSWARM PRIMARY') < c.indexOf('  A. COMMAND DELEGATION'),
    'rule W must precede rule A (subagent-first dispatch pressure)');
});

test('DEVSWARM CHILD + NON-DEVSWARM: orchestration is BYTE-FOR-BYTE the baseline (regression guard)', () => {
  const plain = ctx(sessionStart(undefined));
  const child = ctx(sessionStart(CHILD_ENV));
  assert.ok(plain.length > 0, 'baseline orchestration must be non-empty');
  assert.strictEqual(child, plain, 'a DevSwarm CHILD must get the byte-identical baseline orchestration');
  for (const c of [plain, child]) {
    assert.ok(!c.includes('DEVSWARM PRIMARY'), 'non-Primary output must not carry rule W');
    assert.ok(!c.includes('devswarm.js spawn'), 'non-Primary output must not name devswarm.js spawn');
  }
  // The Primary text is the baseline PLUS rule W spliced before rule A — nothing else.
  const primary = ctx(sessionStart(PRIMARY_ENV));
  assert.notStrictEqual(primary, plain, 'a Primary must get the extra rule');
  const [head, ...restParts] = primary.split('\n  W. DEVSWARM PRIMARY');
  const rest = restParts.join('\n  W. DEVSWARM PRIMARY');
  const stripped = head + '\n' + rest.split('\n').slice(1).join('\n');
  assert.strictEqual(stripped, plain, 'Primary text must be the baseline + rule W and nothing else');
});

// Survive-compaction path.
for (const source of ['compact', 'resume']) {
  test(`SessionStart source="${source}" -> still emits orchestration (survive-compaction path)`, () => {
    const h = makeHome();
    try {
      const r = testHook(
        HOOK,
        { hook_event_name: 'SessionStart', source, session_id: 't', cwd: process.cwd() },
        { home: h.home, expectJson: true },
      );
      assert.strictEqual(r.status, 0, `source=${source} must exit 0`);
      assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(ctx(r).includes('ORCHESTRATION DISCIPLINE'), `source=${source} dropped the orchestration doctrine`);
    } finally {
      h.cleanup();
    }
  });
}

test('FAIL-OPEN: empty stdin -> exit 0 (defaults to SessionStart)', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).includes('ORCHESTRATION DISCIPLINE'));
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});
