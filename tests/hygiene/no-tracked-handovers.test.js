'use strict';
// Handovers are local session state and are never committed. No file tracked in
// THIS repository may match the handover rule (hooks/lib/handover-find.js
// isHandoverPath): anything under .anti-hall/handovers/, or an exact-basename
// HANDOVER*.md / CONTINUE-HERE.md / *.continue-here.md. The plugin's own
// handover skill, KB docs and tests are not named like that, so they pass.
// Skipped when not inside a git checkout (e.g. a tarball).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const cp = require('node:child_process');
const { isHandoverPath } = require('../../plugins/anti-hall/hooks/lib/handover-find.js');

const REPO = path.join(__dirname, '..', '..');

test('no tracked file in this repository is a session handover', (t) => {
  const r = cp.spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  if (r.error || r.status !== 0) return t.skip('not a git checkout (git ls-files unavailable)');
  const files = r.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'git ls-files returned nothing');
  const bad = files.filter(isHandoverPath);
  assert.deepStrictEqual(bad, [], 'handovers must never be committed; untrack with `git rm --cached`: ' + bad.join(', '));
  // sanity: the plugin's own handover skill + KB are tracked and are NOT matched
  for (const keep of ['plugins/anti-hall/skills/handover/SKILL.md', 'docs/KB-session-handover.md']) {
    if (files.includes(keep)) assert.ok(!isHandoverPath(keep), keep);
  }
});
