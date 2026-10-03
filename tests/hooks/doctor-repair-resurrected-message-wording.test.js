'use strict';
// checkResurrectedRows message wording fix (0.99.2). Two independent human
// readers (peer + team-lead) misread the prior phrasing
// "N candidate(s), M needing manual review" as "M of N candidates need
// review" (implying total == N). Under the dryRun:true call this function
// always makes (scripts/devswarm.js's reRetireResurrectedRows returns
// `continue`s right after `candidates++` in dry-run — see :5188 vs :5193-5196
// — so the forward-failed branch at :5244 that would double-count into both
// counters is UNREACHABLE here), `candidates` and `unhealable` are genuinely
// DISJOINT: total = candidates + unhealable. The new message states that sum
// explicitly instead of leaving the reader to (mis)compute it.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPAIR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const repair = require(REPAIR_JS);

// A fake `scripts/devswarm.js` module (the exact seam checkResurrectedRows's
// `devswarmModPath` option already supports) so this test controls
// candidates/unhealable directly rather than driving the real store.
function fakeDevswarmModule(counts) {
  const os = require('os');
  const fs = require('fs');
  const path2 = require('path');
  const dir = fs.mkdtempSync(path2.join(os.tmpdir(), 'antihall-fake-devswarm-'));
  const file = path2.join(dir, 'fake-devswarm.js');
  fs.writeFileSync(file, `
    module.exports = {
      reRetireResurrectedRowsAllStores: function () {
        return ${JSON.stringify(counts)};
      },
    };
  `);
  return file;
}

test('44 total split 24 repairable / 20 unhealable: message states the sum explicitly, unambiguous', () => {
  const modPath = fakeDevswarmModule({ candidates: 24, unhealable: 20 });
  const r = repair.checkResurrectedRows({ devswarmModPath: modPath });
  assert.ok(r, 'must fire when either counter is nonzero');
  assert.strictEqual(r.candidates, 24);
  assert.strictEqual(r.unhealable, 20);
  assert.match(r.message, /^\(warn\) 44 resurrected registry row\(s\): 24 repairable, 20 need manual review \(no safe forward target\)/,
    'must state the TOTAL (44) up front, then the disjoint split — not leave the reader to add 24+20 themselves');
  assert.match(r.message, /run doctor --repair-resurrected to preview a repair plan/);
});

test('all candidates, zero unhealable: no "need manual review" clause tacked on', () => {
  const modPath = fakeDevswarmModule({ candidates: 5, unhealable: 0 });
  const r = repair.checkResurrectedRows({ devswarmModPath: modPath });
  assert.match(r.message, /^\(warn\) 5 resurrected registry row\(s\): 5 repairable \(run doctor --repair-resurrected/);
  assert.doesNotMatch(r.message, /need manual review/);
});

test('all unhealable, zero candidates: still states the total and "0 repairable" explicitly, no repair-plan hint', () => {
  const modPath = fakeDevswarmModule({ candidates: 0, unhealable: 7 });
  const r = repair.checkResurrectedRows({ devswarmModPath: modPath });
  assert.match(r.message, /^\(warn\) 7 resurrected registry row\(s\): 0 repairable, 7 need manual review \(no safe forward target\)\.$/,
    'candidates===0 must omit the "run doctor --repair-resurrected" hint (nothing repairable to preview)');
});

test('both zero: silent (null), unchanged from before', () => {
  const modPath = fakeDevswarmModule({ candidates: 0, unhealable: 0 });
  const r = repair.checkResurrectedRows({ devswarmModPath: modPath });
  assert.strictEqual(r, null);
});
