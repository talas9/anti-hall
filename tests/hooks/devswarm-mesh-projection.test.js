'use strict';
// PLAN-v0.57-mesh.md Phase 8 — projection wiring + hook urgency tiering +
// STRUCTURAL #36 filter (D29). This is the dedicated PHASE ACCEPTANCE suite —
// it proves the cross-hook/integration claims from Phase 8's acceptance list
// that the per-hook unit test files (devswarm-parent-inbox.test.js,
// devswarm-parent-gate.test.js, devswarm-child-turn.test.js) cover per-hook but
// not necessarily side-by-side:
//
//   1. a 3-workspace shared summary renders EACH workspace ONCE (no
//      double-count from the old per-descriptor loop, Opus-auditor P1).
//   2. an urgent direct renders the imperative STOP wording (parent-inbox).
//   3. a plain broadcast renders soft react-if-concerned and NEVER Stop-gates
//      (proven by running devswarm-parent-gate.js against the SAME seeded
//      broadcast data and asserting it never blocks).
//   4. a heartbeat row is tiered as a broadcast and NEVER Stop-gates (D22).
//   5. an urgent broadcast renders loud yet still NEVER Stop-gates (D4
//      orthogonality: urgency governs tier/loudness, type governs gating).
//   6. a mesh direct addressed to a CHILD's meshId is surfaced by that
//      child's turn hook at the correct tier (D26) — see also
//      devswarm-child-turn.test.js's dedicated D26 section.
//   7. the four broadcast visibility cases (irrelevant / relevant / direct /
//      urgent-broadcast) tier + gate correctly (advisory, no
//      concerned-classifier invented, Codex P1).
//   8. a corrupt summary OR a deleted helper module fails open to "no data"
//      in BOTH devswarm-parent-gate.js and devswarm-parent-inbox.js.
//   9. a descriptor from a DIFFERENT repoKey never enters the parent-GATE
//      blocking set nor the parent-inbox attention list, while a descriptor
//      with a null/unresolvable worktreePath is KEPT (fail-open) — #36
//      structural filter (D29), proven side-by-side across BOTH hooks from
//      the SAME seeded cross-project scenario.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const PARENT_INBOX = 'devswarm-parent-inbox.js';
const PARENT_GATE = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function inboxPayload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD };
}
function gatePayload(sessionId) {
  return { hook_event_name: 'Stop', session_id: sessionId || 'sess-1', cwd: REPO_CWD };
}
function inboxCtx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function segment(c, banner) {
  return c.split('\n\n').find((s) => s.startsWith(banner)) || '';
}
function tableRow(c, id) {
  const t = segment(c, 'DEVSWARM WORKSPACES');
  return t.split('\n').find((l) => l.startsWith('| ' + id + ' ')) || '';
}

function swarmDir(home) {
  const d = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function wsEntry(overrides) {
  return Object.assign({
    worktreePath: REPO_CWD,
    sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    total: 0, cursor: 0, unread: 0, directUnread: 0,
    broadcastUnread: 0, urgencyMax: null, working_on: null,
    gates: {}, archive_ready: false,
  }, overrides || {});
}
function writeSharedSummary(home, workspacesRaw, extra) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = {};
  for (const id of Object.keys(workspacesRaw || {})) {
    workspaces[id] = wsEntry(workspacesRaw[id]);
  }
  const obj = {
    generatedAt: Date.now(),
    requiredGates: (extra && extra.requiredGates) || [],
    workspaces,
    recent: (extra && extra.recent) || [],
  };
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(obj));
}
// seedGateDescriptor(home, id, opts) — the raw fs descriptor + durable inbox
// devswarm-parent-gate.js's readDescriptors/readUnread loop consumes (that
// loop is NOT summary-driven, D29).
function seedGateDescriptor(home, id, opts = {}) {
  const root = swarmDir(home);
  const wsDir = path.join(root, 'workspaces');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const descriptor = {
    id,
    worktreePath: opts.worktreePath !== undefined ? opts.worktreePath : REPO_CWD,
    sessionId: 'child-' + id,
    inboxPath,
    cursorPath,
  };
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));
  if (opts.messages != null) {
    fs.writeFileSync(inboxPath, opts.messages.map((m) => JSON.stringify({ m })).join('\n') + '\n');
  }
  if (opts.cursor != null) fs.writeFileSync(cursorPath, String(opts.cursor));
}
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-proj-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. No double-count across 3 workspaces (Opus-auditor P1)
// ---------------------------------------------------------------------------

test('1. 3-workspace shared summary renders EACH workspace exactly ONCE (no double-count)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsOne: { total: 1, cursor: 0, unread: 1, directUnread: 1 },
      wsTwo: { total: 2, cursor: 0, unread: 2, directUnread: 2 },
      wsThree: { archive_ready: true },
    });
    const r = testHook(PARENT_INBOX, inboxPayload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = inboxCtx(r);
    for (const id of ['wsOne', 'wsTwo', 'wsThree']) {
      const rows = c.split('\n').filter((l) => l.startsWith('| ' + id + ' '));
      assert.strictEqual(rows.length, 1, `${id} must appear exactly once in the table; ctx=${c}`);
      const occurrences = c.split(id).length - 1;
      assert.ok(occurrences >= 1 && occurrences <= 2, `${id} must not be double-counted (table + at most one banner); ctx=${c}`);
    }
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// 2/5/7. Urgency tiering — imperative for urgent direct; loud-but-advisory for
// urgent broadcast; the four visibility cases.
// ---------------------------------------------------------------------------

test('2. an urgent DIRECT renders the imperative STOP wording', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsUrgent: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'urgent' } });
    const c = inboxCtx(testHook(PARENT_INBOX, inboxPayload(), { home: h.home, env: PRIMARY_ENV, expectJson: true }));
    assert.match(segment(c, 'DEVSWARM URGENT INBOX'), /STOP and read/);
  } finally { h.cleanup(); }
});

test('7. four visibility cases: irrelevant broadcast / relevant broadcast / direct / urgent-broadcast all tier correctly', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsDirect: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'normal' },
    }, {
      recent: [
        { from: 'peer-irrelevant', summary: 'renamed a variable', ts: Date.now(), urgency: 'low' },
        { from: 'peer-relevant', summary: 'API contract changed for /users', ts: Date.now(), urgency: 'normal' },
        { from: 'peer-urgent', summary: 'prod is down', ts: Date.now(), urgency: 'urgent' },
      ],
    });
    const c = inboxCtx(testHook(PARENT_INBOX, inboxPayload(), { home: h.home, env: PRIMARY_ENV, expectJson: true }));
    // direct: standard tier (urgencyMax 'normal').
    assert.ok(segment(c, 'DEVSWARM PARENT INBOX').includes('wsDirect'), `direct case; ctx=${c}`);
    // irrelevant + relevant broadcasts: both render via the SAME advisory
    // segment (no mechanical relevance classifier, D27) — the model judges.
    const bc = segment(c, 'DEVSWARM BROADCAST');
    assert.ok(bc.includes('peer-irrelevant') && bc.includes('peer-relevant'), `both broadcasts surfaced advisory-only; bc=${bc}`);
    // urgent-broadcast: tagged loud, still inside the SAME advisory segment.
    assert.ok(bc.includes('[URGENT] peer-urgent'), `urgent broadcast tagged loud; bc=${bc}`);
    assert.match(bc, /NEVER blocks/i);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// 3/4/5. NEVER Stop-gate: plain broadcast, heartbeat-shaped row, urgent
// broadcast — proven by running the GATE against the SAME seeded data.
// devswarm-parent-gate.js structurally never reads `recent[]`/broadcasts at
// all (it only reads readDescriptors + readUnread + the Primary's own DIRECT
// unread), so a broadcast-only scenario is a hard no-op for it by
// construction — this test proves that invariant holds under Phase 8's wiring.
// ---------------------------------------------------------------------------

test('3/4/5. broadcasts (plain, heartbeat-shaped, urgent) NEVER Stop-gate — the gate stays silent regardless of broadcast content/urgency', () => {
  const h = makeHome();
  try {
    // A shared summary carrying ONLY broadcast-axis rows (recent[]) and zero
    // direct-unread/stuck workspaces — nothing for the gate's descriptor loop
    // or own-unread read to act on.
    writeSharedSummary(h.home, {}, {
      recent: [
        { from: 'peer-1', summary: 'plain broadcast', ts: Date.now(), urgency: 'normal' },
        { from: 'peer-2', summary: 'working on phase 2', ts: Date.now(), urgency: null }, // heartbeat-shaped
        { from: 'peer-3', summary: 'prod is down, everyone stop', ts: Date.now(), urgency: 'urgent' },
      ],
    });
    // Sanity: the inbox hook DOES surface these (advisory) — proves the data
    // was seeded correctly and is visible to the mesh projection.
    const inboxCtxOut = inboxCtx(testHook(PARENT_INBOX, inboxPayload(), { home: h.home, env: PRIMARY_ENV, expectJson: true }));
    assert.ok(segment(inboxCtxOut, 'DEVSWARM BROADCAST'), `precondition: broadcasts must be visible to parent-inbox; ctx=${inboxCtxOut}`);

    // The gate, given the IDENTICAL home/repo state, must stay silent — no
    // descriptors, no own-unread, and broadcasts are structurally invisible
    // to its raw-descriptor-loop + own-unread read.
    const gr = testHookRaw(PARENT_GATE, JSON.stringify(gatePayload()), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(gr.status, 0);
    assert.strictEqual(gr.stdout, '', `broadcasts (incl. heartbeat-shaped + urgent) must NEVER Stop-gate; stdout=${gr.stdout}`);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// 8. Fail-open: corrupt summary / deleted helper module, in BOTH hooks.
// ---------------------------------------------------------------------------

test('8a. corrupt summary.json fails open to "no data" in BOTH parent-gate and parent-inbox', () => {
  const h = makeHome();
  try {
    const dir = path.join(swarmDir(h.home), 'summaries');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), '{not json');
    seedGateDescriptor(h.home, 'ignored-by-corrupt-summary'); // gate doesn't read this file anyway

    const ir = testHook(PARENT_INBOX, inboxPayload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(ir.status, 0);
    // v0.58: parent-inbox now ALWAYS emits the terse per-turn COMMS OVERRIDE
    // re-assertion (unconditional) — "fails open to no data" means no OTHER
    // segment appears, not that stdout is empty. See devswarm-parent-inbox.test.js.
    const irCtx = (ir.json && ir.json.hookSpecificOutput && ir.json.hookSpecificOutput.additionalContext) || '';
    assert.ok(!/DEVSWARM PARENT INBOX|DEVSWARM WORKSPACES|DEVSWARM ARCHIVE-READY/.test(irCtx),
      `parent-inbox must fail open on a corrupt summary (override only); ctx=${irCtx}`);

    const gr = testHookRaw(PARENT_GATE, JSON.stringify(gatePayload()), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(gr.status, 0, 'parent-gate must exit 0 regardless (it does not read the mesh summary for its blocking set)');
  } finally { h.cleanup(); }
});

test('8b. a corrupt devswarm-repokey.js module fails BOTH hooks open (D27 — lazy/guarded require)', () => {
  const h = makeHome();
  // ISOLATED plugin-tree copy (fs.cpSync into a tmpdir) — `node --test`
  // parallelizes across test FILES (worker threads) and companion/lib/
  // devswarm-repokey.js is required by MANY other concurrently-running test
  // files; corrupting the REAL repo-tree copy would be flaky-by-construction
  // for the whole suite (the exact hazard devswarm-parent-inbox.test.js's own
  // D27 comment documents). Corrupt only this PRIVATE copy instead.
  const pluginSrc = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  const pluginCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-proj-plugin-copy-'));
  try {
    fs.cpSync(pluginSrc, pluginCopy, { recursive: true });
    const repokeyCopyPath = path.join(pluginCopy, 'companion', 'lib', 'devswarm-repokey.js');
    fs.writeFileSync(repokeyCopyPath, 'this is not valid javascript {{{');

    writeSharedSummary(h.home, { wsA: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    seedGateDescriptor(h.home, 'wsA', { messages: ['a'], cursor: 0 });

    const inboxCopy = path.join(pluginCopy, 'hooks', PARENT_INBOX);
    const gateCopy = path.join(pluginCopy, 'hooks', PARENT_GATE);

    const ir = testHookRaw(inboxCopy, JSON.stringify(inboxPayload()), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(ir.status, 0, 'parent-inbox must still exit 0 with a corrupt repokey module');

    const gr = testHookRaw(gateCopy, JSON.stringify(gatePayload()), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(gr.status, 0, 'parent-gate must still exit 0 with a corrupt repokey module');
    // Fail-open means the #36 filter is disabled (selfKey unresolvable) —
    // the real descriptor must still be gated on, not silently dropped.
    assert.strictEqual(gr.json && gr.json.decision, 'block', 'a corrupt repokey module must not blind the gate to a real descriptor (fail-open)');
  } finally {
    h.cleanup();
    fs.rmSync(pluginCopy, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. #36 structural filter — side-by-side across BOTH hooks from the SAME
// seeded cross-project scenario.
// ---------------------------------------------------------------------------

test('9. a DIFFERENT-repoKey descriptor never enters the parent-GATE blocking set nor the parent-inbox attention list; a null-worktreePath one is KEPT (fail-open)', () => {
  const h = makeHome();
  const otherRepo = makeGitRepo();
  try {
    assert.notEqual(repokey.repoKeyForWorktree(otherRepo), REPO_KEY, 'precondition: genuinely different repoKey');

    // Cross-project descriptor (raw fs, gate-side) + cross-project shared-summary
    // entry (inbox-side) — the SAME logical scenario expressed on both read paths.
    // NOTE (gate side only): readDescriptors (companion/devswarm-supervisor.js)
    // itself requires a TRUTHY d.worktreePath before a descriptor is even
    // enumerated — a literal `null` never reaches the #36 loop at all, so the
    // "unresolvable" case here uses a non-existent-but-truthy path (the SAME
    // shape devswarm-parent-gate.test.js's own default seedWorkspace uses),
    // which passes readDescriptors' filter but fails repoKeyForWorktree
    // resolution (not a real git dir) -> fail-open KEPT. The inbox side has no
    // such pre-filter, so its entry below uses a literal `null` directly.
    seedGateDescriptor(h.home, 'foreign-gate', { worktreePath: otherRepo, messages: ['a', 'b'], cursor: 0 });
    seedGateDescriptor(h.home, 'null-wt-gate', { worktreePath: path.join(h.home, 'nonexistent-wt'), messages: ['a', 'b'], cursor: 0 });
    writeSharedSummary(h.home, {
      'foreign-inbox': { total: 2, cursor: 0, unread: 2, directUnread: 2, worktreePath: otherRepo },
      'null-wt-inbox': { total: 2, cursor: 0, unread: 2, directUnread: 2, worktreePath: null },
    });

    const gr = testHookRaw(PARENT_GATE, JSON.stringify(gatePayload()), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(gr.status, 0);
    assert.ok(gr.json && gr.json.decision === 'block', `null-worktreePath descriptor must still gate (fail-open); stdout=${gr.stdout}`);
    assert.ok(!/foreign-gate/.test(gr.json.reason), `foreign-repoKey descriptor must never enter the blocking set; reason=${gr.json.reason}`);
    assert.ok(/null-wt-gate/.test(gr.json.reason), `null-worktreePath descriptor must be named; reason=${gr.json.reason}`);

    const ir = testHook(PARENT_INBOX, inboxPayload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = inboxCtx(ir);
    assert.ok(!c.includes('foreign-inbox'), `foreign-repoKey entry must never enter the attention list/table; ctx=${c}`);
    assert.ok(c.includes('null-wt-inbox'), `null-worktreePath entry must be KEPT (fail-open); ctx=${c}`);
    assert.ok(tableRow(c, 'null-wt-inbox'), `null-worktreePath entry must still get a table row; ctx=${c}`);
  } finally { h.cleanup(); fs.rmSync(otherRepo, { recursive: true, force: true }); }
});
