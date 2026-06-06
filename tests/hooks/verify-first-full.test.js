'use strict';
// verify-first-full (SessionStart). Exit 0; additionalContext is the FULL protocol.
//
// REGRESSION NET: this suite asserts that EVERY structural element of the injected
// additionalContext is present. It guards an upcoming byte-trim of
// plugins/anti-hall/hooks/verify-first-full.js — if a trim silently drops a rule,
// section, or rationalization trigger, the matching assertion below fails and
// NAMES the dropped element. Markers match on the most STABLE token/phrase (not
// whole sentences), so legitimate rewording/whitespace changes do not false-fail,
// but a removed rule does.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'verify-first-full.js';

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

// ---------------------------------------------------------------------------
// Marker tables. Each entry: [stableSubstring, humanLabel-for-failure-message].
// ---------------------------------------------------------------------------

// IRON LAW core phrase.
const IRON_LAW = ['IRON LAW', 'NO SPECULATION'];

// RATIONALIZATION TABLE: header + each trigger-phrase entry. Match the most
// stable token from each row (robust to light rewording).
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

// POSITIVE RULES 1-9: assert the header, each number label, and a distinctive
// keyword from each rule.
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
];

// USER OVERRIDE line: the skip.json / ~/.anti-hall mechanism + the guardrail.
const USER_OVERRIDE = [
  ['USER OVERRIDE', 'USER OVERRIDE label'],
  ['skip.json', 'USER OVERRIDE skip.json mechanism'],
  ['~/.anti-hall', 'USER OVERRIDE ~/.anti-hall path'],
  ['only a direct user instruction', 'USER OVERRIDE guardrail (only a direct user instruction)'],
];

// SCOPE & FIDELITY block: section header + its load-bearing rules.
const SCOPE_FIDELITY = [
  ['SCOPE & FIDELITY', 'SCOPE & FIDELITY section header'],
  ['SIMPLEST solution', 'scope-fidelity: simplest sufficient solution'],
  ['Intent over letter', 'scope-fidelity: intent over letter'],
  ['EXPANDING scope', 'scope-fidelity: confirm before expanding scope'],
  ['blast radius', 'scope-fidelity: match rigor to blast radius'],
];

// ORCHESTRATION DISCIPLINE: header + each letter label A..K (including E2), plus
// a keyword for the load-bearing ones.
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
];

// DISCIPLINES vs SKILLS: ALWAYS APPLY trio + INVOKE-WHEN-IT-MATCHES skills.
const DISCIPLINES = [
  ['DISCIPLINES vs SKILLS', 'DISCIPLINES vs SKILLS section header'],
  ['ALWAYS APPLY', 'ALWAYS APPLY sub-header'],
  ['- root-cause:', 'ALWAYS APPLY: root-cause discipline'],
  ['- orchestration:', 'ALWAYS APPLY: orchestration discipline'],
  ['VERIFY delegated work', 'ALWAYS APPLY orchestration summary: VERIFY delegated work appended'],
  ['against ground truth', 'ALWAYS APPLY orchestration summary: re-check against ground truth'],
  ['- anti-sycophancy:', 'ALWAYS APPLY: anti-sycophancy discipline'],
  ['- scope-fidelity:', 'ALWAYS APPLY: scope-fidelity discipline'],
  ['INVOKE WHEN IT MATCHES', 'INVOKE WHEN IT MATCHES sub-header'],
  ['/anti-hall:root-cause', 'INVOKE skill: root-cause'],
  ['/anti-hall:orchestration', 'INVOKE skill: orchestration'],
  ['/anti-hall:deadly-loop', 'INVOKE skill: deadly-loop'],
  ['/anti-hall:feature-launch', 'INVOKE skill: feature-launch'],
];

function assertAll(c, table) {
  for (const [needle, label] of table) {
    assert.ok(c.includes(needle), `DROPPED: ${label} (missing substring: ${JSON.stringify(needle)})`);
  }
}

test('SessionStart startup -> full protocol present, EVERY section/rule intact (regression net)', () => {
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

    // IRON LAW.
    for (const needle of IRON_LAW) {
      assert.ok(c.includes(needle), `DROPPED: IRON LAW marker (missing ${JSON.stringify(needle)})`);
    }

    // RATIONALIZATION TABLE (header + every trigger).
    assertAll(c, RATIONALIZATION);

    // POSITIVE RULES 1-9 (header, all nine numbers, a keyword each).
    assert.ok(c.includes(POSITIVE_HEADER[0]), `DROPPED: ${POSITIVE_HEADER[1]}`);
    assertAll(c, POSITIVE_RULES);

    // USER OVERRIDE line.
    assertAll(c, USER_OVERRIDE);

    // SCOPE & FIDELITY block.
    assertAll(c, SCOPE_FIDELITY);

    // ORCHESTRATION DISCIPLINE (header + every label A..K incl E2).
    assert.ok(c.includes(ORCHESTRATION_HEADER[0]), `DROPPED: ${ORCHESTRATION_HEADER[1]}`);
    assertAll(c, ORCHESTRATION_LABELS);

    // DISCIPLINES vs SKILLS.
    assertAll(c, DISCIPLINES);
  } finally {
    h.cleanup();
  }
});

// Survive-compaction path: SessionStart re-fires with source="compact" and
// source="resume". Both must still emit the protocol (exit 0, IRON LAW present).
for (const source of ['compact', 'resume']) {
  test(`SessionStart source="${source}" -> still emits protocol (survive-compaction path)`, () => {
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
