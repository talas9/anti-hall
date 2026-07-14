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
  ['  10.', 'positive rule 10 number'],
  ['no real baseline', 'positive rule 10 keyword (no real baseline for per-run savings)'],
];

// RULE 6 ACCEPTANCE-CRITERIA clause ("false done" P0, 0.30.0). The injected
// protocol's positive-rule 6 must carry the AGREED-acceptance done-bar and the
// PENDING OWNER VERIFICATION escape hatch. Asserted on the REAL spawned-hook
// output below (true injection E2E, not a static source check).
const RULE6_ACCEPTANCE = [
  ['AGREED ACCEPTANCE CRITERIA', 'rule 6: DONE = verified against the AGREED ACCEPTANCE CRITERIA'],
  ['PENDING OWNER VERIFICATION', 'rule 6: un-mechanically-verifiable fidelity is PENDING OWNER VERIFICATION'],
  ['SELF-ISSUED HEDGE', 'rule 6: SELF-ISSUED HEDGE hard-blocks done + auto-merge'],
  ['hard-blocks both its', 'rule 6: hedge phrase hard-blocks both "done" status AND auto-merge'],
  ['do not merge', 'rule 6: hedge state = "pending owner review, do not merge"'],
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
  ['/anti-hall:ship-it', 'INVOKE skill: ship-it'],
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

    // RULE 6 acceptance-criteria clause ("false done" P0 fix, 0.30.0) — asserted
    // here on the REAL spawned-hook additionalContext (true injection E2E).
    // Includes: AGREED ACCEPTANCE CRITERIA standard, PENDING OWNER VERIFICATION
    // escape hatch, and SELF-ISSUED HEDGE hard-block (a self-caveat blocks 'done' +
    // auto-merge, state = 'pending owner review, do not merge').
    assertAll(c, RULE6_ACCEPTANCE);

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

// ---------------------------------------------------------------------------
// DEVSWARM PRIMARY: rule W (the workspace tier). The A/C/D/F rules above name
// subagent/Explore/Workflow as the only fan-out targets and apply dispatch pressure
// ("IDLE NEGLECT"); inside DevSwarm that drove a PRIMARY to decompose workspace-scale
// work into subagents instead of spinning child workspaces. Rule W adds the missing,
// higher tier + the choice rule — and ONLY for a Primary. A CHILD workspace and any
// non-DevSwarm session must see BYTE-FOR-BYTE the pre-fix protocol.

const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-x' }; // no SOURCE_BRANCH -> Primary
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y' };

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

test('DEVSWARM PRIMARY: doctrine names the WORKSPACE tier (rule W)', () => {
  const c = ctx(sessionStart(PRIMARY_ENV));
  assert.ok(c.includes('  W. DEVSWARM PRIMARY'), 'rule W missing for a DevSwarm Primary');
  // W is hard budget-capped (see the cap tests below — every char it costs evicts a
  // char of rule A..I off the ~10k window), so it is stated in its shortest
  // load-bearing form and NOTHING more: the classifier (what counts as
  // workspace-scale) and the failure mode (handing that to a subagent). The prose the
  // earlier cuts carried — the full spawn command, "finer -> subagent", "tiers
  // COMPOSE", "shallow + wide", "children never spawn grandchildren" — is deliberately
  // NOT here: it is redundant with rule F and with the per-turn hooks that pay no cap
  // (verify-first.js + task-tracker.js state the full choice rule and the command on
  // EVERY turn), and paying for it here cost rules G/H/I.
  assert.ok(/CHILD WORKSPACE/.test(c), 'rule W must name the child-workspace tier');
  assert.ok(/NOT a subagent/.test(c),
    'rule W must forbid handing a workspace-scale matter to a subagent');
  assert.ok(/feature\/fix\/deploy/.test(c), 'rule W must state what counts as workspace-scale');
  // Placed INSIDE the orchestration block, before rule A (the ~10k injection cap
  // truncates the tail — the tier-choice rule must not sit past it).
  assert.ok(c.indexOf('  W. DEVSWARM PRIMARY') > c.indexOf('ORCHESTRATION DISCIPLINE'),
    'rule W must live inside the ORCHESTRATION DISCIPLINE block');
  assert.ok(c.indexOf('  W. DEVSWARM PRIMARY') < c.indexOf('  A. COMMAND DELEGATION'),
    'rule W must precede rule A (subagent-first dispatch pressure)');
});

// ---------------------------------------------------------------------------
// THE ~10k INJECTION CAP (KB-claude-codex.md §1.6): excess is SILENTLY TRUNCATED.
// The full payload is ~15.3k chars, so the first 10k is ALREADY SATURATED. Rule W
// is spliced in BEFORE rule A, so it is strictly ZERO-SUM: every char W costs
// shifts rules A..I down and evicts a char off the tail of the delivered window.
//
// This is the regression that motivated these tests: the FIRST cut of rule W ran
// 1,276 chars and silently pushed rules G, H and I out of the delivered window —
// including G (SYNTHESIZE, NEVER RELAY), which this very file calls "the #1 cause
// of message-context bloat". It bought the workspace tier by deleting the
// anti-bloat rule, exactly when the Primary is being told to spawn MORE. A second
// cut at 183 chars saved G but still evicted rule H whole.
const CAP = 10000; // chars, per KB-claude-codex.md §1.6

// The rule markers the file actually uses, in delivered order. L is out of
// alphabetical order on purpose (hoisted to survive this same cap — see the
// comment at its definition in the hook).
const RULE_MARKERS = ['\n  A.', '\n  L.', '\n  B.', '\n  C.', '\n  D.', '\n  E.',
  '\n  F.', '\n  G.', '\n  H.', '\n  I.'];

test('DEVSWARM PRIMARY: rules A,L,B,C,D,E,F,G,H,I AND W all land within the ~10k cap', () => {
  const head = ctx(sessionStart(PRIMARY_ENV)).slice(0, CAP);

  // Rule W is worthless if the reader never sees it...
  assert.ok(head.includes('\n  W.'), 'rule W must survive the ~10k cap');
  // ...and it must not buy its own place by pushing a baseline rule out.
  for (const m of RULE_MARKERS) {
    assert.ok(head.includes(m),
      `rule ${m.trim()} was pushed out of the delivered ~10k window by rule W — SHORTEN W.`);
  }
});

// The marker test above is the stated acceptance bar, but marker-presence is a WEAK
// signal: a rule whose marker lands at 9,990 is "present" while 99% of its body is
// truncated. (Baseline rule I is exactly this — its body already ends at 10,181, so
// it is a truncated stub BEFORE any DevSwarm work; that is a pre-existing defect of
// the 15.3k payload, not something rule W caused, and it is out of scope here.)
//
// So this is the invariant that actually has teeth: rule W may not cost any rule that
// the BASELINE delivers WHOLE. Measured, the baseline delivers A..H whole. Both
// figures are derived from the live baseline rather than hardcoded, so a future edit
// to rules A..F re-derives the real ceiling instead of silently invalidating it.
test('DEVSWARM PRIMARY: rule W evicts no WHOLE rule that the baseline delivers', () => {
  const plain = ctx(sessionStart(undefined));
  const primary = ctx(sessionStart(PRIMARY_ENV));
  // W's true cost = the whole delta (the rule + the newline joining it to rule A).
  const cost = primary.length - plain.length;

  // Every rule the baseline delivers WHOLE (marker AND full body inside the window).
  const whole = (text) => RULE_MARKERS.filter((m) => {
    const start = text.indexOf(m);
    if (start < 0) return false;
    const end = start + text.slice(start + 1).split('\n')[0].length + 1;
    return end <= CAP;
  }).map((m) => m.trim());

  const baselineWhole = whole(plain);
  const primaryWhole = whole(primary);
  const lost = baselineWhole.filter((r) => !primaryWhole.includes(r));

  assert.deepStrictEqual(lost, [],
    `rule W (cost ${cost} chars) truncated rule(s) ${lost.join(', ')} that the baseline delivers ` +
    `WHOLE (baseline whole: ${baselineWhole.join(' ')}). SHORTEN W — do not raise this ceiling.`);
});

test('DEVSWARM CHILD + NON-DEVSWARM: protocol is BYTE-FOR-BYTE unchanged (regression guard)', () => {
  const plain = ctx(sessionStart(undefined));
  const child = ctx(sessionStart(CHILD_ENV));
  assert.ok(plain.length > 0, 'baseline protocol must be non-empty');
  assert.strictEqual(child, plain, 'a DevSwarm CHILD must get the byte-identical baseline protocol');
  for (const c of [plain, child]) {
    assert.ok(!c.includes('DEVSWARM PRIMARY'), 'non-Primary output must not carry rule W');
    assert.ok(!c.includes('devswarm.js spawn'), 'non-Primary output must not name devswarm.js spawn');
  }
  // The Primary text is the baseline PLUS rule W — nothing else changed.
  const primary = ctx(sessionStart(PRIMARY_ENV));
  assert.notStrictEqual(primary, plain, 'a Primary must get the extra rule');
  const [head, ...restParts] = primary.split('\n  W. DEVSWARM PRIMARY');
  const rest = restParts.join('\n  W. DEVSWARM PRIMARY');
  const stripped = head + '\n' + rest.split('\n').slice(1).join('\n');
  assert.strictEqual(stripped, plain, 'Primary text must be the baseline + rule W and nothing else');
});
