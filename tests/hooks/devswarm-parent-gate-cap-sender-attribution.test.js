'use strict';
// hooks/devswarm-parent-gate.js — own-outbound (D3) fix + D6 attribution.
//
// CAP SIGNATURE — history: dropping `b.unread` from the cap signature was
// attempted here once and reverted (then: §4.4 requirement D, "a growing
// backlog on the SAME workspace must re-block"). The Phase 5 mesh redesign
// (#14, shared Stop policy — plan decision 2026-09-23) supersedes that: the cap
// is keyed by STABLE block kinds, because a count-keyed budget re-opened on
// every message landing mid-drain (369 Stop blocks in one field transcript).
// A growing backlog is still reported (the reason names the current count);
// the budget re-opens when the condition clears or a new kind appears.
//
// D3 SUPERSEDED (v0.109, Bug 1 fix — "gate count mismatch"): this section used
// to skip a row whose `sender` equalled the Primary's own id on BOTH the
// NDJSON and store-only paths (own outbound sends "not counting as neglect").
// That made this gate disagree with devswarm-store.js's unionUnreadFor — the
// roster / parent-inbox count source of truth — which never applied that
// filter, so a field incident showed the gate blocking with "(1 unread)"
// while the roster/parent-inbox line said "4 unread" for the SAME child in
// the SAME minute (the true, verified count). The sender-based exclusion is
// REMOVED; both surfaces now read through the same `unionUnread` counting
// with no per-sender filter. The original problem D3 traced (the Primary
// self-flagging within seconds of its own send) is now handled by the
// BUSY/liveness check in devswarm-parent-gate.js instead (a provably busy
// child gets an advisory line, never an immediate hard block) — see the
// BUG 2 tests in tests/hooks/devswarm-parent-gate.test.js.
//
// D6 RE-SCOPED — ATTRIBUTION, NOT EXCLUSION: a first attempt (exclude
// archived / app-archived / confirmed-dead-worktree members from the
// identity-family's `unionUnread` sum) was REVERTED after it broke 45
// pre-existing tests in this suite that assert the OPPOSITE by design —
// devswarm-parent-gate-app-archived.test.js "LIVENESS AXIS ONLY: app-archived
// + REAL unread STILL blocks", and devswarm-parent-gate.test.js's "MUST NOT
// BREAK: worktree GONE + STORE-side unread -> STILL blocks on the
// unionUnread axis (nothing is hidden)" / "...ownerKey-ONLY descriptor STILL
// blocks" — a prior, deliberate decision (defects 45cf1659f54f, 0ace80dff415):
// archived/app-archived/dead-worktree suppress ONLY the liveness axis, never
// the unread axis ("archiving does not answer mail"; a gone-worktree row's
// mail is still real and drainable via `inbox ack <id> --ack-as-owner`).
//
// The REAL defect: a blocked Primary reading `primary-<id> — N unread`
// cannot tell whether N is its OWN mail or a SUM including sibling
// descriptors sharing its worktree (identity-family collapse, ~:690-705 +
// the reduce at ~:1324/:1374) — it drains its own inbox, the count doesn't
// move, and it has no way to discover why. FIX (REPORT-ONLY, changes no
// count/decision): `contributors` (per-family, only when >1 member has real
// unread) records each contributing id + count + archived/app-archived/
// worktree-gone flags; buildReason() emits one compact "ATTRIBUTION for
// <survivor> (<total>): <id>: <n> [<flags>] — clear via `inbox ack <id>
// --ack-as-owner`; ..." line per multi-contributor family, naming the exact
// drain command for every non-own contributor.
//
// MUTATION LIST (proven RED against this file):
//   M1 (v0.109, superseded): re-adding the removed NDJSON
//       `row.sender === own.id` skip -> kills "D3 (NDJSON path, v0.109 Bug 1
//       fix): a row with sender === own id STILL counts...".
//   M2: drop the `contributors.length > 1` entry.contributors attachment (or
//       the ATTRIBUTION emission in buildReason)
//       -> kills "ATTRIBUTION line names every contributing sibling...".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { stateFileFor } = require('../../plugins/anti-hall/companion/lib/devswarm-gate-state.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

function run(home, cwd, env) {
  return testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd }), {
    home, env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

// A REAL, standalone git repo — descriptors' worktreePath must resolve to a
// repoKey via `git rev-parse`, same convention as the sibling app-archived
// test file.
function makeWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cs-'));
  const wt = path.join(base, '.devswarm', 'repos', '1', 'aa', 'child');
  fs.mkdirSync(wt, { recursive: true });
  cp.spawnSync('git', ['init', '-q', wt]);
  return {
    wt, key: repokey.repoKeyForWorktree(wt),
    cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} },
  };
}

function seedDescriptor(home, id, worktreePath, opts = {}) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const wsDir = path.join(root, 'workspaces');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const descPath = path.join(wsDir, id + '.json');
  fs.writeFileSync(descPath, JSON.stringify({
    id, worktreePath, sessionId: 'sess-' + id, inboxPath, cursorPath,
  }));
  const rows = opts.rows || (opts.messages ? opts.messages.map((m) => ({ message: m })) : []);
  fs.writeFileSync(inboxPath, rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
  fs.writeFileSync(cursorPath, String(opts.cursor != null ? opts.cursor : 0));
  // Age the descriptor well past any grace window used elsewhere in this file.
  const ageMs = opts.descriptorAgeMs != null ? opts.descriptorAgeMs : 3 * 60 * 60 * 1000;
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(descPath, t, t);
  return { descPath, inboxPath, cursorPath };
}

function seedArchived(home, id, worktreePath) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const dir = path.join(root, 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, worktreePath }));
}

// ---------------------------------------------------------------------------
// Cap signature (Phase 5 #14): a changed unread COUNT alone does NOT reset.
// ---------------------------------------------------------------------------

test('cap does NOT reset when only the unread COUNT changes (stable block kind, Phase 5 #14)', () => {
  const h = makeHome();
  const a = makeWorktree();
  try {
    seedDescriptor(h.home, 'ws1', a.wt, { messages: ['first real message here'] });
    const r1 = run(h.home, a.wt);
    assert.strictEqual(r1.json && r1.json.decision, 'block');
    const state1 = JSON.parse(fs.readFileSync(stateFileFor('sess-1', h.home), 'utf8'));
    assert.strictEqual(state1.blocks, 1);

    // A SECOND real message lands mid-drain -> same kind -> same signature ->
    // the budget ACCUMULATES (no self-amplification); the reason still shows 2.
    seedDescriptor(h.home, 'ws1', a.wt, { messages: ['first real message here', 'second real message here'] });
    const r2 = run(h.home, a.wt);
    assert.strictEqual(r2.json && r2.json.decision, 'block');
    assert.match(r2.json.reason, /2 unread/);

    const state2 = JSON.parse(fs.readFileSync(stateFileFor('sess-1', h.home), 'utf8'));
    assert.strictEqual(state2.blocks, 2, `a changed unread COUNT must accumulate, not reset; state=${JSON.stringify(state2)}`);
    assert.strictEqual(state2.sig, state1.sig, 'the signature is the stable kind set, not the count');
  } finally { a.cleanup(); h.cleanup(); }
});

// ---------------------------------------------------------------------------
// D3: own-sent rows on the NDJSON path
// ---------------------------------------------------------------------------

test('D3 (NDJSON path, v0.109 Bug 1 fix): a row with sender === own id STILL counts — the gate must agree with the roster', () => {
  const h = makeHome();
  const a = makeWorktree();
  try {
    // own.id for a Primary at `a.wt` is `primary-<hash>` (installIngest);
    // resolve it the same way the hook does.
    const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
    const ownId = installIngest.primaryWorkspaceId(a.wt);
    seedDescriptor(h.home, 'ws1', a.wt, {
      rows: [{ message: 'outbound message this Primary itself sent', sender: ownId }],
    });
    const r = run(h.home, a.wt);
    // v0.109 field defect (count mismatch): the OLD behavior here (skip any
    // row whose sender === own.id) made the gate disagree with
    // devswarm-store.js's unionUnreadFor — the roster / parent-inbox source
    // of truth — which applies NO sender filter at all. A real, unread row
    // in a child's mailbox is real backlog regardless of who sent it; the
    // gate must now count it exactly like the roster does. Not-busy here (no
    // heartbeat/live session seeded), so it hard-blocks.
    assert.strictEqual(r.json && r.json.decision, 'block', `an own-sent row is real unread and must count; stdout=${r.stdout}`);
    assert.match(r.json.reason, /1 unread/, `stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('D3 NEGATIVE CONTROL: a row with NO sender field still counts (pre-existing wire shape)', () => {
  const h = makeHome();
  const a = makeWorktree();
  try {
    seedDescriptor(h.home, 'ws1', a.wt, { messages: ['a real inbound message, no sender field at all'] });
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('D3 NEGATIVE CONTROL: a row with a DIFFERENT sender still counts', () => {
  const h = makeHome();
  const a = makeWorktree();
  try {
    seedDescriptor(h.home, 'ws1', a.wt, {
      rows: [{ message: 'a real inbound message from someone else', sender: 'some-other-workspace' }],
    });
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

// ---------------------------------------------------------------------------
// D6 (re-scoped): ATTRIBUTION for a multi-contributor family
// ---------------------------------------------------------------------------

test('ATTRIBUTION: a family with a LIVE sibling + an ARCHIVED sibling names every contributor, still sums the total, and names the drain command for non-own ids', () => {
  const h = makeHome();
  const a = makeWorktree();
  try {
    // Two descriptors sharing the SAME worktree as `cwd` -> collapse into ONE
    // family with the Primary's own synthetic row (own has 0 unread here).
    seedDescriptor(h.home, 'ws-live', a.wt, { messages: ['a real live message needing attention'] });
    seedDescriptor(h.home, 'ws-dead', a.wt, { messages: ['another real message, archived sibling'] });
    seedArchived(h.home, 'ws-dead', a.wt);
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    // The count itself is UNCHANGED behavior — still the sum (2), never hidden.
    assert.match(r.json.reason, /2 unread/, `stdout=${r.stdout}`);
    // The new attribution line names BOTH contributors and their own counts.
    assert.match(r.json.reason, /ATTRIBUTION/, `stdout=${r.stdout}`);
    assert.match(r.json.reason, /ws-live: 1/, `stdout=${r.stdout}`);
    assert.match(r.json.reason, /ws-dead: 1 \[archived\]/, `stdout=${r.stdout}`);
    // A drain command is named for the non-own contributors.
    assert.match(r.json.reason, /inbox ack ws-live --ack-as-owner/, `stdout=${r.stdout}`);
    assert.match(r.json.reason, /inbox ack ws-dead --ack-as-owner/, `stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('ATTRIBUTION: a SINGLE-contributor family gets no ATTRIBUTION line (no regression on the ordinary case)', () => {
  const h = makeHome();
  const a = makeWorktree();
  try {
    seedDescriptor(h.home, 'ws-live', a.wt, { messages: ['a real live message needing attention'] });
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.doesNotMatch(r.json.reason, /ATTRIBUTION/, `stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});
