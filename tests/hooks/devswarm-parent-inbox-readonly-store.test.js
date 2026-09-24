'use strict';
// Mesh redesign Phase 4 (#12): the parent-inbox summary refresh (run when the
// ingest daemon is not healthy — always the case in a test HOME) only READS
// the project store. Looking at a project that has no store yet must not
// provision an empty store directory; a project that HAS one still gets its
// summary refreshed from it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-inbox-ro-store-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

test('no store yet: a Primary turn does not create store/<repoKey>/', () => {
  const repo = makeGitRepo();
  const h = makeHome();
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    assert.ok(repoKey, 'fixture sanity: repo resolves a repoKey');
    const storeDir = storeLib.storeDirForHash(h.home, repoKey);
    assert.strictEqual(fs.existsSync(storeDir), false, 'fixture sanity: no store before the turn');
    const r = testHook(HOOK,
      { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: repo },
      { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.existsSync(storeDir), false, 'a read-only look must not provision ' + storeDir);
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
    h.cleanup();
  }
});

test('existing store: the refresh still derives the summary from it', () => {
  const repo = makeGitRepo();
  const h = makeHome();
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home: h.home, hash: repoKey });
    try { s.upsertRegistry({ id: 'wsA', worktreePath: repo, sessionId: 'sa' }); } finally { s.close(); }
    const summaryPath = path.join(h.home, '.anti-hall', 'devswarm', 'summaries', repoKey + '.json');
    assert.strictEqual(fs.existsSync(summaryPath), false, 'fixture sanity: no summary yet');
    const r = testHook(HOOK,
      { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: repo },
      { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.ok(summary.workspaces && summary.workspaces.wsA, 'summary derived from the existing store: ' + JSON.stringify(summary));
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
    h.cleanup();
  }
});
