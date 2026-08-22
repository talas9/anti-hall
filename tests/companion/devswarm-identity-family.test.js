'use strict';
// devswarm-identity-family — the pure READER-SIDE collapse used by
// hooks/devswarm-parent-gate.js and companion/devswarm-supervisor.js to fold
// two descriptor FILES sharing one worktreePath (a builder-id UUID row and a
// slug row for the SAME worktree — including the Primary's OWN row, the
// live-evidence self-duplication case) into ONE reported entry, without ever
// retiring/deleting/tombstoning any descriptor. No store access, no git
// spawn of its own — every resolver call is injected.

const { test } = require('node:test');
const assert = require('node:assert');

const { familyKeyOf, collapseFamilies } = require('../../plugins/anti-hall/companion/lib/devswarm-identity-family.js');

test('familyKeyOf: same worktreePath -> same key via the injected resolver', () => {
  const resolve = (wt) => 'canon:' + wt;
  const a = { id: 'builder-uuid-1', worktreePath: '/wt/one' };
  const b = { id: 'slug-one', worktreePath: '/wt/one' };
  assert.strictEqual(familyKeyOf(a, { resolve }), familyKeyOf(b, { resolve }));
});

test('familyKeyOf: different worktreePath -> different key', () => {
  const resolve = (wt) => 'canon:' + wt;
  const a = { id: 'a', worktreePath: '/wt/one' };
  const b = { id: 'b', worktreePath: '/wt/two' };
  assert.notStrictEqual(familyKeyOf(a, { resolve }), familyKeyOf(b, { resolve }));
});

test('collapseFamilies: two descriptors sharing one worktreePath -> ONE family, unread union computed by the caller from members', () => {
  const resolve = (wt) => 'canon:' + wt;
  const descriptors = [
    { id: 'builder-uuid-1', worktreePath: '/wt/one', realUnread: 2 },
    { id: 'slug-one', worktreePath: '/wt/one', realUnread: 3 },
  ];
  const families = collapseFamilies(descriptors, { resolve });
  assert.strictEqual(families.length, 1, 'gate reports 1 workspace, not 2');
  assert.strictEqual(families[0].members.length, 2);
  const unionUnread = families[0].members.reduce((sum, m) => sum + m.realUnread, 0);
  assert.strictEqual(unionUnread, 5, 'the UNION of unread across members');
});

test('collapseFamilies: the SELF/Primary row duplicated (live-evidence case) collapses to one', () => {
  // own's synthetic self-row + a real descriptor registered under the SAME
  // canonical mesh id (the literal live-evidence duplication: the SAME id
  // string "primary-63f9261d" appearing twice).
  const resolve = (wt) => (wt === '/repo/self' ? 'primary-63f9261d' : 'canon:' + wt);
  const ownRow = { id: 'primary-63f9261d', worktreePath: '/repo/self', realUnread: 2, unreadUnknown: false };
  const selfDescriptor = { id: 'primary-63f9261d', worktreePath: '/repo/self', realUnread: 0, unreadUnknown: false };
  const families = collapseFamilies([ownRow, selfDescriptor], { resolve });
  assert.strictEqual(families.length, 1, 'the duplicated self row collapses to one family');
  assert.strictEqual(families[0].survivor.id, 'primary-63f9261d');
});

test('collapseFamilies: a descriptor whose worktree no longer exists still groups deterministically, never throws', () => {
  // resolve() degrades exactly like worktreeRealPath -> path.resolve on a
  // realpath failure for a removed worktree: it still returns a stable
  // string keyed off the (non-existent) resolved path, never null/throw.
  const resolve = (wt) => 'resolved:' + wt; // stand-in for "path.resolve degrade"
  const descriptors = [
    { id: 'a', worktreePath: '/vanished/wt' },
    { id: 'b', worktreePath: '/vanished/wt' },
  ];
  let families;
  assert.doesNotThrow(() => { families = collapseFamilies(descriptors, { resolve }); });
  assert.strictEqual(families.length, 1);
  assert.strictEqual(families[0].members.length, 2);
});

test('collapseFamilies: two GENUINELY distinct workspaces are still counted separately (no over-collapse)', () => {
  const resolve = (wt) => 'canon:' + wt;
  const descriptors = [
    { id: 'child-a', worktreePath: '/wt/alpha', realUnread: 1 },
    { id: 'child-b', worktreePath: '/wt/beta', realUnread: 1 },
  ];
  const families = collapseFamilies(descriptors, { resolve });
  assert.strictEqual(families.length, 2, 'distinct worktrees must never be merged');
});

test('collapseFamilies: unreadUnknown on any member is visible for the caller to OR across the family', () => {
  const resolve = (wt) => 'canon:' + wt;
  const descriptors = [
    { id: 'a', worktreePath: '/wt/one', realUnread: 0, unreadUnknown: false },
    { id: 'b', worktreePath: '/wt/one', realUnread: 0, unreadUnknown: true },
  ];
  const families = collapseFamilies(descriptors, { resolve });
  assert.strictEqual(families.length, 1);
  const anyUnknown = families[0].members.some((m) => m.unreadUnknown);
  assert.strictEqual(anyUnknown, true, 'unreadUnknown must propagate to the family via its members');
});

test('FAIL-OPEN: a resolver that throws -> collapseFamilies still returns (never throws), falling back to uncollapsed (per-id) grouping', () => {
  const resolve = () => { throw new Error('boom'); };
  const descriptors = [
    { id: 'a', worktreePath: '/wt/one', realUnread: 1 },
    { id: 'b', worktreePath: '/wt/one', realUnread: 1 },
  ];
  let families;
  assert.doesNotThrow(() => { families = collapseFamilies(descriptors, { resolve }); });
  // A throwing resolver degrades to the per-id fallback key -> today's
  // one-row-per-descriptor behavior for these entries (never over-collapsed,
  // never crashed).
  assert.strictEqual(families.length, 2);
});

test('collapseFamilies: fail-open with NO resolver at all (undefined opts) -> one family per descriptor id', () => {
  const descriptors = [
    { id: 'a', worktreePath: '/wt/one' },
    { id: 'b', worktreePath: '/wt/one' },
  ];
  const families = collapseFamilies(descriptors);
  assert.strictEqual(families.length, 2);
});

test('collapseFamilies: resolver is memoized per distinct worktreePath (never called twice for the same path)', () => {
  let calls = 0;
  const resolve = (wt) => { calls++; return 'canon:' + wt; };
  const descriptors = [
    { id: 'a', worktreePath: '/wt/one' },
    { id: 'b', worktreePath: '/wt/one' },
    { id: 'c', worktreePath: '/wt/one' },
  ];
  const families = collapseFamilies(descriptors, { resolve });
  assert.strictEqual(families.length, 1);
  assert.strictEqual(calls, 1, 'the resolver must be memoized per distinct worktreePath');
});

test('collapseFamilies: survivor prefers the member whose id already equals the resolved family key', () => {
  const resolve = (wt) => 'primary-abc123';
  const descriptors = [
    { id: 'builder-uuid-xyz', worktreePath: '/repo' },
    { id: 'primary-abc123', worktreePath: '/repo' },
  ];
  const families = collapseFamilies(descriptors, { resolve });
  assert.strictEqual(families.length, 1);
  assert.strictEqual(families[0].survivor.id, 'primary-abc123');
});

test('collapseFamilies: no member equals the canonical key -> deterministic stable-sorted first member (not random/order-dependent)', () => {
  const resolve = () => 'primary-nomatch';
  const forward = collapseFamilies(
    [{ id: 'zeta', worktreePath: '/repo' }, { id: 'alpha', worktreePath: '/repo' }],
    { resolve },
  );
  const reversed = collapseFamilies(
    [{ id: 'alpha', worktreePath: '/repo' }, { id: 'zeta', worktreePath: '/repo' }],
    { resolve },
  );
  assert.strictEqual(forward[0].survivor.id, 'alpha');
  assert.strictEqual(reversed[0].survivor.id, 'alpha');
});

test('collapseFamilies: preserves input order of families and members', () => {
  const resolve = (wt) => 'canon:' + wt;
  const descriptors = [
    { id: 'first', worktreePath: '/wt/A' },
    { id: 'second', worktreePath: '/wt/B' },
    { id: 'third', worktreePath: '/wt/A' },
  ];
  const families = collapseFamilies(descriptors, { resolve });
  assert.strictEqual(families.length, 2);
  assert.strictEqual(families[0].members.map((m) => m.id).join(','), 'first,third');
  assert.strictEqual(families[1].members[0].id, 'second');
});
