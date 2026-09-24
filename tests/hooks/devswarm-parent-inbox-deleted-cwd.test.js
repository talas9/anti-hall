'use strict';
// B3 P1 FIX (Codex review): devswarm-parent-inbox.js's main() resolves
// `gitTop` (the caller's own worktree) via companion/lib/identity.js's
// resolveContext. B3 first called it with NO missingPath option, which
// meant a payload.cwd that no longer exists on disk resolved to kind
// 'deleted' (worktreeRoot null) — dropping `gitTop`, and with it `repoKey`
// (derived FROM `gitTop`, so it cascades), which drops the OWN INBOX nudge
// segment entirely. The OLD findGitToplevel (a pure fs walk-up to the
// nearest EXISTING ancestor) never had this problem.
//
// Fix: `gitTop` now resolves via `missingPath: 'ancestor'`. Unlike
// devswarm-parent-gate.js's readOwnUnread (where the SEPARATE `selfKey`
// resolution intentionally stays null-by-default), this hook derives
// `repoKey` FROM the already-ancestor-resolved `gitTop`
// (`repokeyMod.repoKeyForWorktree(gitTop)`), so once `gitTop` is fixed,
// `repoKey` is the real, correctly-keyed value — the nudge reads the SAME
// modern summaries/<repoKey>.json file a normal (non-deleted) cwd would.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-inbox-deleted-cwd-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function segment(c, banner) {
  return c.split('\n\n').find((s) => s.startsWith(banner)) || '';
}
function ownSegment(c) {
  return segment(c, 'DEVSWARM OWN INBOX');
}

function writeSharedSummary(home, repoKey, ownId, unread) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const obj = {
    generatedAt: Date.now(), requiredGates: [], recent: [],
    workspaces: { [ownId]: { total: unread, cursor: 0, unread, directUnread: unread } },
  };
  fs.writeFileSync(path.join(dir, repoKey + '.json'), JSON.stringify(obj));
}

test('OWN UNREAD: the own-inbox nudge still surfaces when payload.cwd is a DELETED subdirectory of the Primary\'s repo', () => {
  const repo = makeGitRepo();
  const h = makeHome();
  try {
    const deletedSub = path.join(repo, 'src', 'gone');
    fs.mkdirSync(deletedSub, { recursive: true });
    fs.rmSync(deletedSub, { recursive: true, force: true });
    assert.ok(!fs.existsSync(deletedSub), 'fixture sanity: the subdirectory must genuinely not exist');

    const repoKey = repokey.repoKeyForWorktree(repo);
    assert.ok(repoKey, 'fixture sanity: the ancestor repo must itself resolve a repoKey');
    const ownId = 'primary-' + installIngest.worktreeHash(repo);
    writeSharedSummary(h.home, repoKey, ownId, 4);

    const r = testHook(HOOK,
      { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: deletedSub },
      { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const own = ownSegment(ctx(r));
    assert.ok(own, `own-unread nudge expected even with a deleted cwd; ctx=${ctx(r)}`);
    assert.ok(own.includes(ownId), `must name the ancestor-resolved own id; own=${own}`);
  } finally {
    h.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
