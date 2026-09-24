'use strict';
// devswarm-parent-gate.js — v0.106.0 regression: the Primary's OWN descriptor
// (workspaces/<own.id>.json) was counted TWICE. The own row (readOwnUnread ->
// the summary / this reader's own reader_cursors row) already accounts for the
// Primary's mailbox, but the descriptor loop ALSO counted the same partition via
// countFor(reader:null) — the FLOOR view. With the floor pinned below the
// Primary's own row, that produced a phantom "primary-… (you) (205 unread,
// live-resolved)" block. Fix: the descriptor loop skips the descriptor whose id
// is own.id.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const meshStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const rc = require('../../plugins/anti-hall/companion/lib/reader-cursors.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + installIngest.worktreeHash(REPO_CWD);

function seedOwn(home, { total, floor }) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  // Own summary: this reader's own row is at the partition total -> 0 unread.
  fs.mkdirSync(path.join(root, 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(root, 'summaries', REPO_KEY + '.json'), JSON.stringify({
    workspaces: { [OWN_ID]: { unread: 0, total, cursor: total } }, archivedRegistryRows: [],
  }));
  // The Primary's OWN descriptor (the live SkyCrew shape: workspaces/primary-<hash>.json).
  const inboxPath = path.join(root, 'inbox', OWN_ID + '.ndjson');
  const cursorPath = path.join(root, 'cursors', OWN_ID + '.json');
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(inboxPath, '');
  fs.writeFileSync(cursorPath, '0');
  fs.writeFileSync(path.join(root, 'workspaces', OWN_ID + '.json'), JSON.stringify({
    id: OWN_ID, worktreePath: REPO_CWD, sessionId: 'sess-primary-own', inboxPath, cursorPath, repoKey: REPO_KEY,
  }));
  // Store partition: `total` rows, stored floor pinned at `floor` < total.
  const s = meshStore.openStore({ home, workspaceId: OWN_ID, hash: REPO_KEY });
  try {
    for (let i = 1; i <= total; i++) {
      meshStore.appendMeshMessage(s, { from: 'some-child', to: OWN_ID, type: 'direct', message: 'row ' + i, timestamp: Date.now(), hash: 'own-desc-' + i });
    }
    rc.importLegacy(s, { partition: OWN_ID, home, harnesses: [], procTable: new Map() });
    rc.ackFor(s, { partition: OWN_ID, ns: 'store', reader: null, target: floor, home, procTable: new Map() });
    assert.strictEqual(rc.floorOf(s, OWN_ID, 'store', { home }), floor, 'precondition: floor pinned below total');
  } finally { s.close(); }
}

test('own descriptor present + floor < total + own row at total -> no block, no floor-view count under (you)', () => {
  const h = makeHome();
  try {
    seedOwn(h.home, { total: 7, floor: 2 });
    const r = testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-own-desc' }), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    const reason = r.json && r.json.reason ? String(r.json.reason) : '';
    assert.ok(!/5 unread/.test(reason), 'the floor view (total - floor = 5) must not be reported: ' + reason);
    assert.strictEqual(r.json, null, 'nothing is unread for this Primary; stdout=' + r.stdout);
  } finally { h.cleanup(); }
});
