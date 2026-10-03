'use strict';
// Round 13 item 5 (PERF) — computeSummary must not materialise every
// partition's full store history on every projection.
//
// COST PROBLEM: the unread-unification fix routed computeSummary through the
// shared `unionUnread` primitive, which reads a partition's ENTIRE history
// TWICE (`listMessages(id)` for the total dedup, `listMessages(id,{sinceCursor})`
// for the unread dedup) — bodies included. computeSummary runs that once PER
// REGISTRY ROW on EVERY projection; on this machine's 60-row registry that is
// 120 full history reads per projection, paid on every roster/gate/read path.
//
// THE UNION IS PROVABLY REDUNDANT WHEN THE NDJSON SIDE HAS NO UNREAD LINES:
// with zero unread lines nothing is filtered out of the store's unread rows,
// so `union.unread` reduces exactly to `total - cursor`, the value
// computeSummary already computed. So it is now skipped in that case, which is
// the overwhelmingly common shape (an absent inbox, an empty one, or a cursor
// already at the line count).
//
// The store handle below is a STUB that COUNTS body reads — the assertion is a
// measured call count, not a timing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-perf-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });
  return home;
}

// A minimal store handle with the surface computeSummary touches, counting
// every listMessages call (each of which materialises message BODIES).
function stubStore(home, rows, opts) {
  const o = opts || {};
  const counts = { listMessages: 0, byId: {} };
  const handle = {
    hash: 'stub-repo-key',
    workspaceId: null,
    counts,
    listRegistry: () => rows,
    messageCount: (id) => (o.totals && o.totals[id] != null ? o.totals[id] : 10),
    cursorValue: (id) => (o.cursors && o.cursors[id] != null ? o.cursors[id] : 10),
    // The BROADCAST partition read is a fixed, per-projection cost unrelated to
    // the per-row union — excluded so the counter measures only what this fix
    // is about.
    listMessages: (id) => {
      if (String(id) !== '*mesh-broadcast*') {
        counts.listMessages++;
        counts.byId[id] = (counts.byId[id] || 0) + 1;
      }
      return [];
    },
    // The dedicated needs-reply read (already pushed down for perf); present so
    // computeSummary never falls back to a full listMessages for it.
    listNeedsReply: () => [],
    currentGates: () => ({}),
    listStoreHashes: () => [],
  };
  return handle;
}

function registryRows(n, mk) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mk(i));
  return out;
}

test('R13 item 5: 60 rows with EMPTY NDJSON channels perform ZERO listMessages body reads', () => {
  const home = tmpHome();
  try {
    const inboxDir = path.join(home, 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    const rows = registryRows(60, (i) => {
      const id = 'ws-' + i;
      const inboxPath = path.join(inboxDir, id + '.ndjson');
      const cursorPath = path.join(inboxDir, id + '.cursor');
      fs.writeFileSync(inboxPath, ''); // a real, EMPTY durable inbox
      fs.writeFileSync(cursorPath, '0');
      return { id, worktreePath: home, sessionId: 'sess-' + i, inboxPath, cursorPath };
    });
    // cursor === total on every row -> zero store unread -> computeSummary's
    // own `unread > 0 ? listMessages(...) : []` branch also reads nothing, so
    // any listMessages call that DOES happen came from the union.
    const s = stubStore(home, rows, {
      totals: Object.fromEntries(rows.map((r) => [r.id, 10])),
      cursors: Object.fromEntries(rows.map((r) => [r.id, 10])),
    });

    store.computeSummary(s, { home, env: {}, now: Date.now() });

    assert.strictEqual(s.counts.listMessages, 0,
      'THE FIX: an NDJSON channel with no unread lines makes the union provably redundant, so it is skipped entirely. '
      + 'Pre-fix this was 120 full-history reads (2 per row x 60 rows). Got ' + s.counts.listMessages);
  } finally { rm(home); }
});

test('R13 item 5: a row that DOES have unread NDJSON lines still pays for the union (correctness preserved)', () => {
  const home = tmpHome();
  try {
    const inboxDir = path.join(home, 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    const id = 'ws-with-mail';
    const inboxPath = path.join(inboxDir, id + '.ndjson');
    const cursorPath = path.join(inboxDir, id + '.cursor');
    fs.writeFileSync(inboxPath, JSON.stringify({ _h: 'h1', message: 'hello' }) + '\n');
    fs.writeFileSync(cursorPath, '0'); // one UNREAD line
    const rows = [{ id, worktreePath: home, sessionId: 'sess', inboxPath, cursorPath }];
    const s = stubStore(home, rows, { totals: { [id]: 5 }, cursors: { [id]: 5 } });

    store.computeSummary(s, { home, env: {}, now: Date.now() });

    assert.ok(s.counts.listMessages > 0,
      'the skip is scoped to "nothing to union" — a row with a real unread NDJSON tail still runs the full union');
  } finally { rm(home); }
});

test('R13 item 5: a row with NO durable inbox at all is unchanged (the pre-existing skip still holds)', () => {
  const home = tmpHome();
  try {
    const rows = [{ id: 'ws-bare', worktreePath: home, sessionId: 'sess' }];
    const s = stubStore(home, rows, { totals: { 'ws-bare': 3 }, cursors: { 'ws-bare': 3 } });
    store.computeSummary(s, { home, env: {}, now: Date.now() });
    assert.strictEqual(s.counts.listMessages, 0);
  } finally { rm(home); }
});

test('R13 item 5: the skip does not change the reported unread count', () => {
  const home = tmpHome();
  try {
    const inboxDir = path.join(home, 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    const id = 'ws-counted';
    const inboxPath = path.join(inboxDir, id + '.ndjson');
    const cursorPath = path.join(inboxDir, id + '.cursor');
    fs.writeFileSync(inboxPath, '');
    fs.writeFileSync(cursorPath, '0');
    const rows = [{ id, worktreePath: home, sessionId: 'sess', inboxPath, cursorPath }];
    // total 9, cursor 4 -> 5 store-side unread, and an EMPTY NDJSON tail, so the
    // union's answer is arithmetically identical to the store-only answer.
    const s = stubStore(home, rows, { totals: { [id]: 9 }, cursors: { [id]: 4 } });
    const sum = store.computeSummary(s, { home, env: {}, now: Date.now() });
    const row = (sum.workspaces || {})[id]; // workspaces is a MAP keyed by id
    assert.ok(row, 'the row is still projected: ' + JSON.stringify(Object.keys(sum.workspaces || {})));
    assert.strictEqual(row.unread, 5,
      'skipping the union must be behaviour-preserving, not just cheaper');
  } finally { rm(home); }
});
