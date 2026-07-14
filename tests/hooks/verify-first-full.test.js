'use strict';
// verify-first-full (SessionStart) — the verify-first FOUNDATION + discipline/skill
// index. Exit 0; additionalContext = the CORE protocol (Iron Law + rationalization
// table + Positive Rules + Scope & Fidelity) followed by the DISCIPLINES-vs-SKILLS
// index. The ORCHESTRATION DISCIPLINE ruleset (rules A-N + DevSwarm rule W) is
// delivered by the companion SessionStart hook verify-first-orch.js (split to keep
// each hook under the ~10,000-char injection cap — see verify-first-orch.test.js
// and injection-cap.test.js).
//
// REGRESSION NET: this suite asserts every structural element of THIS hook's
// injected additionalContext is present. Markers match on the most STABLE
// token/phrase (not whole sentences), so legitimate rewording/whitespace changes do
// not false-fail, but a removed rule does.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'verify-first-full.js';
const CAP = 10000; // per code.claude.com/docs/en/hooks; over this -> spill-to-file

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

// ---------------------------------------------------------------------------
// Marker tables. Each entry: [stableSubstring, humanLabel-for-failure-message].
// ---------------------------------------------------------------------------

const IRON_LAW = ['IRON LAW', 'NO SPECULATION'];

const RATIONALIZATION = [
  ['RATIONALIZATION TABLE', 'rationalization table header'],
  ['probably', "trigger: 'it's probably X'"],
  ['should work', "trigger: 'should work'"],
  ['seems to', "trigger: 'seems to'"],
  ["I'll just assume", "trigger: 'I'll just assume Y'"],
  ['likely the cause', "trigger: 'likely the cause'"],
  ['the test will pass', "trigger: 'the test will pass'"],
  ['close enough', "trigger: 'close enough'"],
  ['X because Y', "trigger: 'X because Y' (inference-as-fact)"],
  ['presumably', "trigger: hedging list (plausibly/likely/presumably/I suspect/...)"],
  ['I suspect', "trigger: hedging list member 'I suspect'"],
  ['must be', "trigger: hedging list member 'must be'"],
  ['alert/metric', "trigger: reading an alert/metric/dashboard/log as a cause"],
  ['breakdown', "trigger alert/metric remedy: get the breakdown"],
];

const POSITIVE_HEADER = ['POSITIVE RULES', 'positive rules header'];
const POSITIVE_RULES = [
  ['  1.', 'positive rule 1 number'],
  ['Collect evidence first', 'positive rule 1 keyword (collect evidence first)'],
  ['  2.', 'positive rule 2 number'],
  ['Verify every fact', 'positive rule 2 keyword (verify every fact)'],
  ['  3.', 'positive rule 3 number'],
  ['ROOT cause', 'positive rule 3 keyword (prove the ROOT cause)'],
  ['  4.', 'positive rule 4 number'],
  ['instrument', 'positive rule 4 keyword (instrument)'],
  ['  5.', 'positive rule 5 number'],
  ["I don't know", 'positive rule 5 keyword (say I don\'t know)'],
  ['  6.', 'positive rule 6 number'],
  ['THIS turn', 'positive rule 6 keyword (claim done only after running THIS turn)'],
  ['  7.', 'positive rule 7 number'],
  ['narrative padding', 'positive rule 7 keyword (no narrative padding)'],
  ['  8.', 'positive rule 8 number'],
  ['[inference]', 'positive rule 8 keyword (label claims [inference])'],
  ['  9.', 'positive rule 9 number'],
  ['User agreement is not correctness', 'positive rule 9 keyword (user agreement is not correctness)'],
  ['  10.', 'positive rule 10 number'],
  ['no real baseline', 'positive rule 10 keyword (no real baseline for per-run savings)'],
];

const RULE6_ACCEPTANCE = [
  ['AGREED ACCEPTANCE CRITERIA', 'rule 6: DONE = verified against the AGREED ACCEPTANCE CRITERIA'],
  ['PENDING OWNER VERIFICATION', 'rule 6: un-mechanically-verifiable fidelity is PENDING OWNER VERIFICATION'],
  ['SELF-ISSUED HEDGE', 'rule 6: SELF-ISSUED HEDGE hard-blocks done + auto-merge'],
  ['hard-blocks both its', 'rule 6: hedge phrase hard-blocks both "done" status AND auto-merge'],
  ['do not merge', 'rule 6: hedge state = "pending owner review, do not merge"'],
];

const USER_OVERRIDE = [
  ['USER OVERRIDE', 'USER OVERRIDE label'],
  ['skip.json', 'USER OVERRIDE skip.json mechanism'],
  ['~/.anti-hall', 'USER OVERRIDE ~/.anti-hall path'],
  ['only a direct user instruction', 'USER OVERRIDE guardrail (only a direct user instruction)'],
];

const SCOPE_FIDELITY = [
  ['SCOPE & FIDELITY', 'SCOPE & FIDELITY section header'],
  ['SIMPLEST solution', 'scope-fidelity: simplest sufficient solution'],
  ['Intent over letter', 'scope-fidelity: intent over letter'],
  ['EXPANDING scope', 'scope-fidelity: confirm before expanding scope'],
  ['blast radius', 'scope-fidelity: match rigor to blast radius'],
];

// DISCIPLINES vs SKILLS index: ALWAYS APPLY quartet + INVOKE-WHEN-IT-MATCHES skills.
// This index lives in the FOUNDATION hook (with the core), not with the
// orchestration ruleset — the two orchestration-flavored entries summarize
// disciplines whose full rules ride the companion verify-first-orch injection.
const DISCIPLINES = [
  ['DISCIPLINES vs SKILLS', 'DISCIPLINES vs SKILLS section header'],
  ['ALWAYS APPLY', 'ALWAYS APPLY sub-header'],
  ['- root-cause:', 'ALWAYS APPLY: root-cause discipline'],
  ['- orchestration:', 'ALWAYS APPLY: orchestration discipline'],
  ['VERIFY delegated work', 'ALWAYS APPLY orchestration summary: VERIFY delegated work'],
  ['against ground truth', 'ALWAYS APPLY orchestration summary: re-check against ground truth'],
  ['- anti-sycophancy:', 'ALWAYS APPLY: anti-sycophancy discipline'],
  ['- scope-fidelity:', 'ALWAYS APPLY: scope-fidelity discipline'],
  ['- model-routing:', 'ALWAYS APPLY: model-routing discipline'],
  ['INVOKE WHEN IT MATCHES', 'INVOKE WHEN IT MATCHES sub-header'],
  ['/anti-hall:root-cause', 'INVOKE skill: root-cause'],
  ['/anti-hall:orchestration', 'INVOKE skill: orchestration'],
  ['/anti-hall:deadly-loop', 'INVOKE skill: deadly-loop'],
  ['/anti-hall:ship-it', 'INVOKE skill: ship-it'],
];

function assertAll(c, table) {
  for (const [needle, label] of table) {
    assert.ok(c.includes(needle), `DROPPED: ${label} (missing substring: ${JSON.stringify(needle)})`);
  }
}

test('SessionStart startup -> foundation protocol present, EVERY core section/rule intact', () => {
  const h = makeHome();
  try {
    const r = testHook(
      HOOK,
      { hook_event_name: 'SessionStart', source: 'startup', session_id: 't', cwd: process.cwd() },
      { home: h.home, expectJson: true },
    );
    assert.strictEqual(r.status, 0, 'hook must exit 0');
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart', 'echoes SessionStart event');

    const c = ctx(r);
    assert.ok(c.length > 0, 'additionalContext must be non-empty');

    for (const needle of IRON_LAW) {
      assert.ok(c.includes(needle), `DROPPED: IRON LAW marker (missing ${JSON.stringify(needle)})`);
    }
    assertAll(c, RATIONALIZATION);
    assert.ok(c.includes(POSITIVE_HEADER[0]), `DROPPED: ${POSITIVE_HEADER[1]}`);
    assertAll(c, POSITIVE_RULES);
    assertAll(c, RULE6_ACCEPTANCE);
    assertAll(c, USER_OVERRIDE);
    assertAll(c, SCOPE_FIDELITY);
    assertAll(c, DISCIPLINES);
  } finally {
    h.cleanup();
  }
});

test('foundation hook stays under the ~10k cap with headroom (does not spill)', () => {
  const h = makeHome();
  try {
    const c = ctx(testHook(
      HOOK,
      { hook_event_name: 'SessionStart', source: 'startup', session_id: 't', cwd: process.cwd() },
      { home: h.home, expectJson: true },
    ));
    assert.ok(c.length <= CAP, `foundation additionalContext ${c.length} > ${CAP} — would spill to file`);
    assert.ok(c.length <= 9000, `foundation additionalContext ${c.length} > 9000 — target headroom breached`);
  } finally {
    h.cleanup();
  }
});

test('SEAM: the orchestration RULESET (A-N + rule W) lives in the companion hook, not here', () => {
  const h = makeHome();
  try {
    // Test under a DevSwarm-Primary env too — rule W must never appear in THIS hook.
    for (const env of [undefined, { DEVSWARM_REPO_ID: 'repo-x' }]) {
      const c = ctx(testHook(
        HOOK,
        { hook_event_name: 'SessionStart', source: 'startup', session_id: 't', cwd: process.cwd() },
        { home: h.home, env, expectJson: true },
      ));
      assert.ok(!c.includes('  A. COMMAND DELEGATION'), 'rule A must NOT be in the foundation hook (moved to verify-first-orch)');
      assert.ok(!c.includes('  N. DISTRIBUTE MODELS'), 'rule N must NOT be in the foundation hook (moved to verify-first-orch)');
      assert.ok(!c.includes('DEVSWARM PRIMARY'), 'rule W must NOT be in the foundation hook (moved to verify-first-orch)');
      assert.ok(!c.includes('devswarm.js spawn'), 'the spawn command must NOT be in the foundation hook');
    }
  } finally {
    h.cleanup();
  }
});

// Survive-compaction path: SessionStart re-fires with source="compact"/"resume".
for (const source of ['compact', 'resume']) {
  test(`SessionStart source="${source}" -> still emits foundation (survive-compaction path)`, () => {
    const h = makeHome();
    try {
      const r = testHook(
        HOOK,
        { hook_event_name: 'SessionStart', source, session_id: 't', cwd: process.cwd() },
        { home: h.home, expectJson: true },
      );
      assert.strictEqual(r.status, 0, `source=${source} must exit 0`);
      assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
      const c = ctx(r);
      assert.ok(c.includes('IRON LAW'), `source=${source} dropped IRON LAW`);
      assert.ok(c.includes('NO SPECULATION'), `source=${source} dropped NO SPECULATION`);
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
    assert.ok(ctx(r).includes('IRON LAW'));
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
