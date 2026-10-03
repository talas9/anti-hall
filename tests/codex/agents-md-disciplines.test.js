'use strict';
// Codex-side parity guard for the always-apply disciplines mirrored in AGENTS.md.
//
// Claude Code gets these disciplines through hook injection (verify-first-full.js /
// verify-first-subagent.js / verify-first-orch.js). Codex has no equivalent injection
// channel, so AGENTS.md is the ONLY place the same disciplines reach a Codex agent.
// A Claude-side discipline added without its AGENTS.md mirror silently drifts the two
// ports apart -- exactly what the dual-platform parity rule forbids. This suite pins
// the mirror's presence (semantic parity, not literal wording -- the prose mirror is
// deliberately phrased for AGENTS.md's section structure).
//
// Assertions run against a whitespace-FLATTENED copy so a reflow of AGENTS.md's
// 90-column prose wrapping never breaks a substring match.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_MD = path.resolve(__dirname, '..', '..', 'AGENTS.md');
const doc = fs.readFileSync(AGENTS_MD, 'utf8');
const flat = doc.replace(/\s+/g, ' ');

test('AGENTS.md mirrors the autonomous-execution discipline', () => {
  assert.ok(
    flat.includes('## Autonomous execution (always apply)'),
    'AGENTS.md must carry an always-apply Autonomous execution section',
  );
  assert.ok(
    flat.includes('execute the WHOLE scope to done without pausing to re-confirm steps that authorization already covers'),
    'must state: run the authorized scope to done without re-confirming covered steps',
  );
  assert.ok(
    flat.includes('ONE consolidated end result'),
    'must state: one consolidated report, not a stream of confirmation requests',
  );
  assert.ok(
    flat.includes('autonomous-execution'),
    'the intro discipline roll-call must name autonomous-execution',
  );
});

test('AGENTS.md autonomous-execution preserves the existing safety gates', () => {
  assert.ok(
    flat.includes('destructive or irreversible action'),
    'destructive/irreversible stop-point must be preserved',
  );
  assert.ok(
    flat.includes('deletions still require explicit confirmation'),
    'never-delete-without-confirmation must be preserved',
  );
  assert.ok(
    flat.includes('DONE still means VERIFIED (positive rule 6)'),
    'positive rule 6 (DONE = verified) must not be weakened',
  );
  assert.ok(
    flat.includes('EXPANDING scope past what was authorized still requires confirmation'),
    'scope-expansion confirmation (Scope & fidelity) must not be bypassed',
  );
});

test('AGENTS.md states the scannable output style as the DEFAULT, with drift correction', () => {
  assert.ok(
    flat.includes('signal, not decoration'),
    'emoji-as-signal (never decoration) must be preserved',
  );
  assert.ok(
    flat.includes('is the DEFAULT for every user-facing report'),
    'scannable style must be stated as the DEFAULT, not an occasional flourish',
  );
  assert.ok(
    flat.includes('sliding back to bare plain text over a long session is DRIFT'),
    'regression to bare plain text must be named as drift to correct',
  );
});
