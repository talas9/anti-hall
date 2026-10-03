'use strict';
// B3 P1 FIX (Codex review): devswarm-parent-gate.js's readOwnUnread resolves
// `top` (the caller's own worktree) via companion/lib/identity.js's
// resolveContext. B3 first called it with NO missingPath option, which meant
// resolveContext returns kind 'deleted' (toplevel/worktreeRoot null) for a
// payload.cwd that no longer exists on disk — so a Primary whose session
// directory got removed mid-turn (a worktree cleanup racing the Stop hook)
// silently stopped being gated on its own unread backlog, exactly the
// failure mode the OLD findGitToplevel (a pure fs walk-up to the nearest
// EXISTING ancestor) never had.
//
// Fix: readOwnUnread now passes `missingPath: 'ancestor'`. Note: `selfKey`
// (main()'s SEPARATE repoKeyForWorktree(cwd) resolution, used to prefer the
// modern repoKey-keyed summary file) intentionally stays null for a deleted
// cwd — repoKey is a fold/partition key, and B3's decision is that those
// default to 'null' (never silently walked onto an enclosing repo's
// identity). readOwnUnread already had a resilient fallback for exactly this
// case: `hash = repoKey || legacyHash`, where legacyHash is
// installIngest.worktreeHash(top) — and `top` IS correctly ancestor-resolved
// by this fix, so the gate still finds and blocks on the Primary's own
// unread via the legacy-hash-keyed summary file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-deleted-cwd-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

function writeOwnSummaryLegacy(home, legacyHash, id, unread) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const summary = { workspaces: { [id]: { unread } }, archivedRegistryRows: [] };
  fs.writeFileSync(path.join(dir, legacyHash + '.json'), JSON.stringify(summary));
}

function stopPayload(sessionId, cwd) {
  return { hook_event_name: 'Stop', session_id: sessionId, cwd };
}

test('BLOCK: the own-unread gate still fires when payload.cwd is a DELETED subdirectory of the Primary\'s repo', () => {
  const repo = makeGitRepo();
  const h = makeHome();
  try {
    const deletedSub = path.join(repo, 'src', 'gone');
    fs.mkdirSync(deletedSub, { recursive: true });
    fs.rmSync(deletedSub, { recursive: true, force: true });
    assert.ok(!fs.existsSync(deletedSub), 'fixture sanity: the subdirectory must genuinely not exist');

    const legacyHash = installIngest.worktreeHash(repo);
    const id = 'primary-' + legacyHash;
    writeOwnSummaryLegacy(h.home, legacyHash, id, 5);

    const r = testHookRaw(HOOK, JSON.stringify(stopPayload('sess-deleted-cwd', deletedSub)), {
      home: h.home, env: PRIMARY_ENV,
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.strictEqual(r.json.decision, 'block', `must block on the Primary's own 5 unread even with a deleted cwd; reason=${r.json && r.json.reason}`);
    assert.match(r.json.reason, new RegExp(id), 'must name the ancestor-resolved own id');
  } finally {
    h.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
