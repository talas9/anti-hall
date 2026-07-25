'use strict';
// devswarm-question-protocol (SessionStart hook: devswarm-child-role.js).
//
// Verifies the blocking-question escalation protocol — condensed from
// skills/devswarm/SKILL.md "Blocking questions — CHILD asks, PARENT answers
// (never child -> human)" — MECHANICALLY reaches every DevSwarm workspace
// session via the SessionStart injection, not just the skill doc. Also
// guards the ~10k Claude Code per-hook additionalContext injection cap
// (verify-first-full.js header) so this addition never risks spill-to-file.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'devswarm-child-role.js';
// Claude Code's documented per-hook additionalContext cap (see
// plugins/anti-hall/hooks/verify-first-full.js header comment). Assert well
// under it, not just under it, so there is real headroom for future growth.
const INJECTION_CAP = 10000;

function sessionPayload() {
  return { hook_event_name: 'SessionStart', source: 'startup', session_id: 't' };
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_AI_AGENT: 'claude' };
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '', DEVSWARM_AI_AGENT: 'claude' };

test('CHILD: gets the blocking-question protocol with all key markers', () => {
  const h = makeHome();
  try {
    const c = ctx(testHook(HOOK, sessionPayload(), { home: h.home, expectJson: true, env: CHILD_ENV }));
    // never-block: a question parks one sub-task, never halts all work, never goes to the human.
    assert.ok(/never ask the human directly/i.test(c), `must state never-ask-human; ctx=${c}`);
    assert.ok(/never halt all work/i.test(c), `must state never-halt-all-work; ctx=${c}`);
    assert.ok(/parks ONE sub-task/.test(c), `must state one-sub-task scoping; ctx=${c}`);
    // send --to-primary channel (also present in OVERRIDE_CORE, but must be
    // present in this workspace's injected text either way).
    assert.ok(/send --to-primary/.test(c), `must reference send --to-primary; ctx=${c}`);
    // default-and-proceed with the loud, non-silent flag requirement.
    assert.ok(/DEFAULT-AND-PROCEED/.test(c), `must name DEFAULT-AND-PROCEED; ctx=${c}`);
    assert.ok(/flag it LOUDLY as an explicit assumption/i.test(c), `must require loud flagging; ctx=${c}`);
    assert.ok(/never silently/i.test(c), `must forbid silent proceeding; ctx=${c}`);
    // the one hard-stop: destructive/irreversible action, park + report, no guessed default.
    assert.ok(/destructive\/irreversible action/i.test(c), `must name the destructive/irreversible hard-stop; ctx=${c}`);
    assert.ok(/do not guess a default/i.test(c), `hard-stop must not get a guessed default; ctx=${c}`);
    // escalation ladder: child -> parent -> human, never child -> human.
    assert.ok(/child -> parent -> human/.test(c), `must state the ladder; ctx=${c}`);
    assert.ok(/never child -> human/.test(c), `must forbid child -> human directly; ctx=${c}`);
  } finally {
    h.cleanup();
  }
});

test('PRIMARY: gets the brief parent-facing reply protocol, same ladder, no child-only language', () => {
  const h = makeHome();
  try {
    const c = ctx(testHook(HOOK, sessionPayload(), { home: h.home, expectJson: true, env: PRIMARY_ENV }));
    assert.ok(/BLOCKED-QUESTION REPLIES/.test(c), `Primary must get the reply-protocol line; ctx=${c}`);
    assert.ok(/send --to <meshId>/.test(c), `Primary must reply via send --to <meshId>; ctx=${c}`);
    assert.ok(/escalate to the human only for a genuine human call/i.test(c), `must bound human escalation; ctx=${c}`);
    assert.ok(/child -> parent -> human/.test(c), `Primary copy must also state the ladder; ctx=${c}`);
    assert.ok(/never child -> human/.test(c), `Primary copy must also forbid child -> human; ctx=${c}`);
    // Primary must NOT get the child-only send-a-question instruction text.
    assert.ok(!/BLOCKED ON A DECISION\?/.test(c), `Primary must not get the child question-sending prompt; ctx=${c}`);
    assert.ok(!/DEFAULT-AND-PROCEED/.test(c), `Primary is not the one defaulting-and-proceeding; ctx=${c}`);
  } finally {
    h.cleanup();
  }
});

test('CAP: worst-case injected payload (child + Claude wake directive) stays well under the ~10k hook cap', () => {
  const h = makeHome();
  try {
    const c = ctx(testHook(HOOK, sessionPayload(), { home: h.home, expectJson: true, env: CHILD_ENV }));
    assert.ok(c.length < INJECTION_CAP, `child payload ${c.length} chars must stay under the ${INJECTION_CAP}-char cap`);
    // Real headroom check, not just "under the line" — this addition must be
    // TIGHT, not merely non-fatal.
    assert.ok(c.length < INJECTION_CAP * 0.5, `child payload ${c.length} chars should stay well under half the cap; ctx.length=${c.length}`);
  } finally {
    h.cleanup();
  }
});

test('CAP: Primary worst-case payload also stays well under the cap', () => {
  const h = makeHome();
  try {
    const c = ctx(testHook(HOOK, sessionPayload(), { home: h.home, expectJson: true, env: PRIMARY_ENV }));
    assert.ok(c.length < INJECTION_CAP, `Primary payload ${c.length} chars must stay under the ${INJECTION_CAP}-char cap`);
  } finally {
    h.cleanup();
  }
});

test('HOOK-TEXT SWEEP: the question-protocol text never reintroduces the blocked native verbs', () => {
  const h = makeHome();
  try {
    for (const env of [CHILD_ENV, PRIMARY_ENV]) {
      const c = ctx(testHook(HOOK, sessionPayload(), { home: h.home, expectJson: true, env }));
      assert.ok(!/message-parent/.test(c), `must never emit message-parent; ctx=${c}`);
      assert.ok(!/message-child/.test(c), `must never emit message-child; ctx=${c}`);
    }
  } finally {
    h.cleanup();
  }
});

test('NO-OP: non-DevSwarm session gets neither block (baseline unaffected)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});
