'use strict';
// The handover skill contract (Claude + Codex mirror) carries the three
// content rules: a verbatim "Session rules" slot, the seq-N carry-forward
// rule, and the receiver read-back on resume. Both ports must say the same.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const SKILLS = {
  claude: path.join(ROOT, 'skills', 'handover', 'SKILL.md'),
  codex: path.join(ROOT, 'codex', 'skills', 'anti-hall-handover', 'SKILL.md'),
};

for (const [port, file] of Object.entries(SKILLS)) {
  const body = fs.readFileSync(file, 'utf8');

  test(`${port} handover skill: Session rules (verbatim) slot in the contract AND the skeleton`, () => {
    assert.match(body, /^2a\. \*\*Session rules \(verbatim\)\*\*/m);
    assert.match(body, /^## Session rules \(verbatim\)$/m);
    assert.match(body, /quoted EXACTLY/);
  });

  test(`${port} handover skill: seq N>1 carry-forward rule (verbatim, with evidence, never re-summarized)`, () => {
    assert.match(body, /\*\*Carry-forward rule \(seq N>1\)\.\*\*/);
    assert.match(body, /verbatim, with their original evidence/);
    assert.match(body, /\(carried from <predecessor file>\)/);
  });

  test(`${port} handover skill: receiver read-back after the resume checklist`, () => {
    assert.match(body, /\*\*receiver read-back\*\*/);
    assert.match(body, /- \[ \] read-back to the user: goal, next action, active session rules/);
  });

  test(`${port} handover skill: Trigger line required in the contract AND the skeleton`, () => {
    assert.match(body, /^1a\. \*\*Trigger\*\*/m);
    assert.match(body, /auto-threshold.*user-request.*restart-pending.*task-boundary/s);
    assert.match(body, /^Trigger: <auto-threshold\|user-request\|restart-pending\|task-boundary> · context: <pct%\|unknown>$/m);
    // Source pointer: the statusline or the auto-handover latch file.
    assert.match(body, /~\/\.anti-hall\/auto-handover\/<tag>\.json/);
    assert.match(body, /firedPct/);
  });

  test(`${port} handover skill: terminal declaration is trigger-aware, never an unconditional "safe" claim`, () => {
    assert.match(body, /\*\*Terminal declaration is trigger-aware\.\*\*/);
    // Decisive line only for auto-threshold / explicit compact-clear request.
    assert.match(body, /HANDOVER COMPLETE — GOOD POINT/);
    // Proactive, non-decisive line for restart-pending / task-boundary below threshold.
    assert.match(body, /📝 \*\*Handover saved\*\* \(proactive,\s+context <pct>%\): no need to (?:compact|reset) now/);
    // The old unconditional unbolded "safe" declaration syntax
    // (`✅ **X** ...` immediately after "Once met, the final message is:")
    // must be gone — the field-incident note may still quote the retired
    // wording for context, so check the OLD declaration shape, not the words.
    assert.doesNotMatch(body, /Once met, the final message is: `✅/);
  });
}
