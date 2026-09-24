'use strict';
// R15 item 2 (P2) — an ARCHIVED row must still surface a REAL not-draining
// backlog, not lose it wholesale.
//
// Field/audit finding: devswarm-parent-inbox.js's per-turn table replaced an
// archived row's label with `{ label: 'archived', rank: 6 }` UNCONDITIONALLY —
// so an archived workspace with a genuinely aging unread backlog lost its
// `not-draining` (rank 1.5) signal entirely, exactly the coordination-neglect
// axis that label exists to name (a separate axis from the liveness one
// archiving legitimately suppresses — see displayStatus's own rank order,
// where `not-draining` already outranks every other liveness label).
//
// P0 FOLLOW-UP (field bug): the "+N archived" table-collapsing display
// elsewhere hides rows labeled exactly 'archived' — an APP-archived row
// (archived via the DevSwarm app UI, never anti-hall's own archived/<id>.json
// marker — appArchivedRow) that ALSO carried a stored notDraining verdict
// kept rendering 'not-draining' and so was NEVER collapsed. A LOCALLY-
// archived row (archivedRow && !appArchivedRow) keeps the R15 P2 behavior
// above unchanged; only the app-archived case is forced plain 'archived'.
//
// displayStatus itself is unit-tested elsewhere (devswarm-parent-inbox-idle-
// alive.test.js) and untouched by this fix; this file pins the ARCHIVED-ROW
// BRANCH inside main() that used to bypass displayStatus's own priority order
// wholesale.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INBOX = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-parent-inbox.js');
const src = fs.readFileSync(INBOX, 'utf8');

test('item 2: the archived branch now consults notDrainingFlag instead of an unconditional swap', () => {
  assert.ok(/const notDrainingFlag = !!\(verdict && verdict\.notDraining\);/.test(src),
    'notDrainingFlag must be computed once and reused for both branches');
  assert.ok(
    /archivedRow\s*\n\s*\?\s*\(appArchivedRow \? \{ label: 'archived', rank: 6 \} : \(notDrainingFlag \? \{ label: 'not-draining', rank: 1\.5 \} : \{ label: 'archived', rank: 6 \}\)\)/.test(src),
    'a LOCALLY-archived row with a real not-draining backlog must render not-draining, not archived'
  );
});

test('MUTATION: reverting the archived branch to an unconditional swap loses the not-draining backlog', () => {
  const buggy = src.replace(
    "archivedRow\n        ? (appArchivedRow ? { label: 'archived', rank: 6 } : (notDrainingFlag ? { label: 'not-draining', rank: 1.5 } : { label: 'archived', rank: 6 }))\n        : archivedSuperseded\n          ? (notDrainingFlag ? { label: 'not-draining', rank: 1.5 } : { label: 'archived-superseded (live child)', rank: 5.5 })\n          : displayStatus(archiveReady, status, activityTs, now, dormant, notDrainingFlag, idleAlive);",
    "archivedRow\n        ? { label: 'archived', rank: 6 }\n        : archivedSuperseded\n          ? { label: 'archived-superseded (live child)', rank: 5.5 }\n          : displayStatus(archiveReady, status, activityTs, now, dormant, notDrainingFlag, idleAlive);"
  );
  assert.notStrictEqual(buggy, src, 'mutant target string not found verbatim in the live source');
  assert.ok(!/notDrainingFlag \? \{ label: 'not-draining'/.test(buggy),
    'the mutant must reproduce the old unconditional-swap bug (proves the string match above is load-bearing)');
});

test('item 2 P0 follow-up: an APP-archived row forces plain "archived" regardless of notDrainingFlag', () => {
  assert.ok(
    /appArchivedRow \? \{ label: 'archived', rank: 6 \}/.test(src),
    'an app-archived row must always render plain archived so the "+N archived" collapse catches it'
  );
});

// defect df54edf54804 hardening — an id whose archived/<id>.json marker exists
// but was SUPERSEDED (a live child re-registered it with a different sessionId,
// the shape 7e1ae67's supersede rule + this migration fix both key on) must be
// labeled distinctly, not silently fall back into the ordinary displayStatus
// liveness ladder as if it had never been archived at all.
test('item 3 (defect df54edf54804): a superseded-archived row is labeled distinctly, still yielding to not-draining', () => {
  assert.ok(
    /archivedSuperseded\s*\n\s*\?\s*\(notDrainingFlag \? \{ label: 'not-draining', rank: 1\.5 \} : \{ label: 'archived-superseded \(live child\)', rank: 5\.5 \}\)/.test(src),
    'a superseded-archived row with a real not-draining backlog must still render not-draining'
  );
});
