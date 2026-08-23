'use strict';
// NON-DRIFT GUARD for the A2 archived-stranded split.
//
// devswarm-orphan-policy.js quiets exactly the orphans healOrphanPartitions calls
// `unhealable / archived-no-family`. It calls heal's OWN exported helpers, but the
// live-first/archived-fallback descriptor composition is its own (devswarm.js's
// resolveOrphanDescriptor is private). This test drives BOTH sides over the same
// fixtures and asserts the id sets are IDENTICAL, so if either side's policy moves,
// CI fails loudly instead of silently hiding (or silently re-nagging about) an orphan.
//
// Uses a TEMP home only — never the real store. heal runs with dryRun:true, which
// still opens the store in write mode, hence the fixture-only rule.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const policy = require('../../plugins/anti-hall/companion/lib/devswarm-orphan-policy.js');
const devswarm = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-orphanpolicy-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function writeDescriptor(home, sub, id, desc) {
  const dir = path.join(home, '.anti-hall', 'devswarm', sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, desc)), 'utf8');
}

test('archived-stranded classifier == healOrphanPartitions archived-no-family', () => {
  const home = tmpHome();
  try {
    const repoKey = 'fixture-abc123'; // heal opens store/<repoKey>/ — open the fixture in the SAME bucket
    const s = store.openStore({ home, hash: repoKey, backend: 'journal' });

    // 1. archived, worktree gone, no family anywhere -> archived-no-family
    writeDescriptor(home, 'archived', 'stranded-a', { worktreePath: path.join(home, 'gone-a') });
    s.appendMessage({ workspaceId: 'stranded-a', body: 'x', hash: 'a1' });

    // 2. archived, family HAS a live registry row -> forwardable, NOT stranded
    const shared = path.join(home, 'wt-shared');
    fs.mkdirSync(shared, { recursive: true });
    s.upsertRegistry({ id: 'live-sibling', worktreePath: shared, sessionId: 'sess-1', inboxPath: '/i', cursorPath: '/c', nudgeCommand: null });
    writeDescriptor(home, 'workspaces', 'live-sibling', { worktreePath: shared, sessionId: 'sess-1' });
    writeDescriptor(home, 'archived', 'archived-with-family', { worktreePath: shared });
    s.appendMessage({ workspaceId: 'archived-with-family', body: 'x', hash: 'b1' });

    // 3. not archived at all -> adoptable, NOT stranded
    const wtLive = path.join(home, 'wt-live');
    fs.mkdirSync(wtLive, { recursive: true });
    writeDescriptor(home, 'workspaces', 'plain-orphan', { worktreePath: wtLive, sessionId: 'sess-2' });
    s.appendMessage({ workspaceId: 'plain-orphan', body: 'x', hash: 'c1' });

    // 4. archived, no descriptor readable -> no-descriptor, NOT stranded
    const adir = path.join(home, '.anti-hall', 'devswarm', 'archived');
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, 'no-desc.json'), '{broken', 'utf8');
    s.appendMessage({ workspaceId: 'no-desc', body: 'x', hash: 'd1' });

    const registry = s.listRegistry();
    const candidates = s.listWorkspaceIds().map(String)
      .filter((id) => id !== store.BROADCAST_PARTITION_ID)
      .filter((id) => !registry.some((d) => String(d.id) === id));
    const isStranded = policy.makeArchivedStrandedTest(home, registry);
    const mine = candidates.filter(isStranded).sort();
    s.close();

    // heal's OWN verdict over the same fixture home (dry run: classify, never write)
    const res = devswarm.healOrphanPartitions(home, { env: {}, dryRun: true, repoKey, backend: 'journal' });
    const detail = (res && res.detail) || [];
    const heals = detail
      .filter((d) => d.action === 'unhealable' && d.reason === 'archived-no-family')
      .map((d) => String(d.id)).sort();

    assert.deepStrictEqual(mine, ['stranded-a'], 'sanity: the fixture must produce exactly one stranded id');
    assert.deepStrictEqual(mine, heals,
      'the projection classifier and healOrphanPartitions MUST agree on archived-no-family');
  } finally { rm(home); }
});
