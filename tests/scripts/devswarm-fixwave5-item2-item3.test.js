'use strict';
// Fix Wave 5 (DevSwarm P0/P1 batch, Items 2 and 3). Item 1 (cross-child
// partition consumption) is deliberately NOT touched by this wave — see the
// Wave 5 report: the proposed "never write a sibling's cursor" fix was found
// to directly contradict extensively-tested, deliberate mesh-drain semantics
// (tests/scripts/devswarm-fixwave3-g1-g2-g3.test.js's G1/G2/G3 tests all
// assert a FOREIGN `read-primary` call legitimately advances a sibling's
// cursor over REAL delivered content, not just over corrupt/waste rows), so
// it was reported rather than shipped. This file covers ONLY Items 2 and 3.
//
// MUTATION LIST (documented, applied+proven per rule):
//   Item 2 mutant: revert the ack-all (no --to) NDJSON cursor target in
//     cmdInbox (scripts/devswarm.js) from
//     `inboxCursor.ackTo(cursorPath, union.cursor + union.ndjsonUnreadLines.length, undefined, inboxPath)`
//     back to the pre-fix `inboxCursor.advanceCursor(inboxPath, cursorPath)`
//     — RED: a line appended to the inbox between the read (union snapshot)
//     and the ack write is silently swallowed (over-acked, never delivered).
//   Item 3 mutant (buildUnreadSegment): revert `inbox read-primary ' + info.id`
//     to the pre-fix `inbox read ' + info.id` (the non-acking verb) in
//     hooks/devswarm-child-turn.js — RED: the segment text names the
//     non-mutating verb, which devswarm-parent-gate.js:1403's own convention
//     (and this same file's buildMeshDirectSegment/own-unread segments)
//     never does for a party's own durable-inbox unread.
//   Item 3 mutant (RECEIVE_NUDGE): revert `inbox read-primary ' + '<DEVSWARM_BUILDER_ID>'`
//     to the pre-fix `inbox read ' + '<DEVSWARM_BUILDER_ID>'` — RED: same
//     non-acking-verb defect, this time with zero paired ack step anywhere.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const devswarmUnread = require('../../plugins/anti-hall/companion/lib/devswarm-unread.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');
const { testHook } = require('../helpers/spawn-hook.js');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const CHILD_TURN_HOOK_PATH = path.join(PLUGIN_ROOT, 'hooks', 'devswarm-child-turn.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave5-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave5-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, inboxPath, cursorPath) {
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', 's-' + id, '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
}

// ---------------------------------------------------------------------------
// Item 2 — standalone `inbox ack` must not recount the live file tail
// ---------------------------------------------------------------------------

// raceHarness: registers `id` with an NDJSON descriptor inbox pre-seeded with
// `initialLines`, monkeypatches devswarmUnread.unionUnread (the SAME module
// singleton scripts/devswarm.js requires — module-identity-preserving, same
// technique tests/scripts/devswarm-fixwave3-g1-g2-g3.test.js's
// withInjectedHole uses on devswarm-store.js) so that, for exactly ONE call,
// AFTER the real snapshot is captured but BEFORE it is returned to the
// caller, `extraLine` is appended to the live inbox file — modeling a
// concurrent sender racing between this call's read and its ack write. Runs
// `theCli.run(['inbox', 'ack', id], ...)` against `theCli` and returns the
// resulting cursor value read back off disk.
function raceHarness(theCli, home, repo, id, initialLines, extraLine) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(inboxPath, initialLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  register(home, repo, id, inboxPath, cursorPath);

  const realUnionUnread = devswarmUnread.unionUnread;
  let patched = false;
  devswarmUnread.unionUnread = function (opts) {
    const result = realUnionUnread(opts);
    if (!patched) {
      patched = true;
      // Simulate a concurrent arrival landing AFTER this call's read
      // snapshot was taken but BEFORE its ack write runs.
      fs.appendFileSync(inboxPath, JSON.stringify(extraLine) + '\n');
    }
    return result;
  };
  try {
    const r = theCli.run(['inbox', 'ack', id], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, 'ack failed: ' + JSON.stringify(r.result));
  } finally {
    devswarmUnread.unionUnread = realUnionUnread;
  }
  const rawCursor = fs.readFileSync(cursorPath, 'utf8').trim();
  return Number(rawCursor);
}

test('Item 2 RED/GREEN (end-to-end): a message arriving between read and ack must survive standalone `inbox ack`', () => {
  const home = tmpHome();
  const repo = makeGitRepo('item2');
  try {
    const initial = [{ body: 'L1' }, { body: 'L2' }];
    const arrival = { body: 'L3-concurrent' };
    const cursorAfter = raceHarness(cli, home, repo, 'child-item2', initial, arrival);
    assert.equal(cursorAfter, 2, 'THE FIX: ack must advance only over the 2-line snapshot it actually read, never the live file\'s current 3-line tail');

    // The concurrently-arrived line must still be reachable as unread.
    const r2 = cli.run(['inbox', 'count', 'child-item2'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result));
    assert.equal(r2.result.cursorNdjson, 2, 'cursor must sit at 2, not swallow L3');
    assert.ok(r2.result.unreadNdjson >= 1, 'L3-concurrent must still read as unread — never lost');
  } finally { rm(home); rm(repo); }
});

test('Item 2 mutation check: reverting the ack-all target to advanceCursor() reproduces the live-recount loss', () => {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  const oldStr = 'cursor = inboxCursor.ackTo(cursorPath, union.cursor + union.ndjsonUnreadLines.length, undefined, inboxPath); // ack-all (ndjson side) — over THIS call\'s read snapshot only';
  assert.ok(liveBefore.includes(oldStr), 'Item 2 fix line not found verbatim in cmdInbox ack-all branch');
  const buggyStr = 'cursor = inboxCursor.advanceCursor(inboxPath, cursorPath); // ack-all (ndjson side)';
  const copy = mutantKit.createCopy('anti-hall-fixwave5-item2');
  try {
    mutantKit.mutate(copy.devswarmPath, oldStr, buggyStr);
    const mutatedCli = mutantKit.requireFresh(copy.devswarmPath);
    const home = tmpHome();
    const repo = makeGitRepo('item2-mutant');
    try {
      const initial = [{ body: 'L1' }, { body: 'L2' }];
      const arrival = { body: 'L3-concurrent' };
      const cursorAfter = raceHarness(mutatedCli, home, repo, 'child-item2m', initial, arrival);
      assert.equal(cursorAfter, 3, 'BUGGY (pre-fix): advanceCursor() recounts the live 3-line file and over-acks past the concurrently-arrived L3');
    } finally { rm(home); rm(repo); }
  } finally {
    mutantKit.discardCopy(copy);
  }
  mutantKit.assertLiveUntouched(liveBefore, assert);
});

// ---------------------------------------------------------------------------
// Item 3 — non-acking verb must not be prescribed to a child for its own
// durable-inbox unread
// ---------------------------------------------------------------------------

function seedChildInbox(home, id, lines, consumed) {
  const dsw = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(dsw, id + '.inbox.ndjson');
  const cursorPath = path.join(dsw, id + '.cursor.json');
  fs.mkdirSync(dsw, { recursive: true });
  fs.writeFileSync(inboxPath, lines.map((l) => l).join('\n') + (lines.length ? '\n' : ''));
  fs.writeFileSync(cursorPath, String(consumed));
  const wdir = path.join(dsw, 'workspaces');
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify({ id, inboxPath, cursorPath }));
}

function promptPayload(sessionId, cwd) {
  return { session_id: sessionId || 'sess', cwd: cwd || '/tmp', hook_event_name: 'UserPromptSubmit', prompt: 'go' };
}

function makeChildEnv(builderId) {
  return { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: builderId };
}

function ctxText(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

// scratchHookCopy: mirrors PLUGIN_ROOT's layout (hooks/ + companion/) inside a
// tmp dir so devswarm-child-turn.js's relative requires (`./lib/...`,
// `../companion/lib/...`) still resolve, WITHOUT ever writing the live hook
// file — same never-touch-the-live-source contract
// tests/scripts/lib/devswarm-mutant-kit.js enforces for scripts/devswarm.js,
// applied here to a hooks/ file instead (that kit is hardcoded to
// scripts/devswarm.js's own layout, so it cannot be reused directly).
function scratchHookCopy(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'anti-hall-hookmutant') + '-'));
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir);
  const hookPath = path.join(hooksDir, 'devswarm-child-turn.js');
  fs.copyFileSync(CHILD_TURN_HOOK_PATH, hookPath);
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'hooks', 'lib'), path.join(hooksDir, 'lib'), 'dir');
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'companion'), path.join(dir, 'companion'), 'dir');
  return { dir, hookPath };
}
function discardHookCopy(copy) {
  try { fs.rmSync(copy.dir, { recursive: true, force: true }); } catch (_) {}
}
function mutateHook(hookPath, oldStr, newStr) {
  const before = fs.readFileSync(hookPath, 'utf8');
  if (!before.includes(oldStr)) throw new Error('mutant target string not found verbatim: ' + JSON.stringify(oldStr.slice(0, 120)));
  const after = before.replace(oldStr, newStr);
  if (after === before) throw new Error('mutant produced no change');
  fs.writeFileSync(hookPath, after);
}

test('Item 3 RED/GREEN (end-to-end): buildUnreadSegment must prescribe the ACKING read-primary verb, never bare `inbox read <id>`', () => {
  const h = tmpHome();
  try {
    seedChildInbox(h, 'child-item3', ['from parent: rebase now'], 0);
    const r = testHook(CHILD_TURN_HOOK_PATH, promptPayload('sess-item3'), {
      home: h, expectJson: true, env: makeChildEnv('child-item3'),
    });
    assert.strictEqual(r.status, 0);
    const c = ctxText(r);
    assert.ok(/DEVSWARM CHILD INBOX — PRIORITY/.test(c), `durable-inbox segment expected; ctx=${c}`);
    assert.ok(c.includes('inbox read-primary child-item3'), `THE FIX: must prescribe the acking read-primary verb; ctx=${c}`);
    assert.ok(!c.includes('inbox read child-item3'), `must NEVER prescribe the bare non-acking "inbox read <id>" form; ctx=${c}`);
  } finally { rm(h); }
});

test('Item 3 mutation check (buildUnreadSegment): reverting to the bare `inbox read <id>` form reproduces the non-acking-verb defect', () => {
  const liveBefore = fs.readFileSync(CHILD_TURN_HOOK_PATH, 'utf8');
  const oldStr = "cursor — `node ' + CLI + ' inbox read-primary ' + info.id + '` (anti-hall devswarm CLI). '";
  assert.ok(liveBefore.includes(oldStr), 'Item 3 buildUnreadSegment fix line not found verbatim');
  const buggyStr = "cursor — `node ' + CLI + ' inbox read ' + info.id + '` (anti-hall devswarm CLI). '";
  const copy = scratchHookCopy('anti-hall-fixwave5-item3a');
  try {
    mutateHook(copy.hookPath, oldStr, buggyStr);
    const h = tmpHome();
    try {
      seedChildInbox(h, 'child-item3m', ['from parent: rebase now'], 0);
      const r = testHook(copy.hookPath, promptPayload('sess-item3m'), {
        home: h, expectJson: true, env: makeChildEnv('child-item3m'),
      });
      assert.strictEqual(r.status, 0);
      const c = ctxText(r);
      // Scoped to the DEVSWARM CHILD INBOX — PRIORITY segment specifically:
      // defect 735b179362e8's id-substitution fix means RECEIVE_NUDGE (a
      // SEPARATE, always-present paragraph, unrelated to this mutation)
      // now legitimately ALSO contains 'inbox read-primary child-item3m'
      // once the real id is substituted — a whole-context substring check
      // can no longer tell the two apart.
      const priorityIdx = c.indexOf('DEVSWARM CHILD INBOX — PRIORITY');
      assert.ok(priorityIdx !== -1, `PRIORITY segment must be present; ctx=${c}`);
      const prioritySegment = c.slice(priorityIdx, priorityIdx + 400);
      assert.ok(prioritySegment.includes('inbox read child-item3m'), `BUGGY (pre-fix): must reproduce the bare non-acking form; segment=${prioritySegment}`);
      assert.ok(!prioritySegment.includes('inbox read-primary child-item3m'), `BUGGY: must NOT accidentally carry the fixed form; segment=${prioritySegment}`);
    } finally { rm(h); }
  } finally { discardHookCopy(copy); }
  assert.equal(fs.readFileSync(CHILD_TURN_HOOK_PATH, 'utf8'), liveBefore, 'live devswarm-child-turn.js must never be modified by a mutation test');
});

test('Item 3 RED/GREEN (unit): RECEIVE_NUDGE must prescribe read-primary, never bare `inbox read <BUILDER_ID>` with no paired ack', () => {
  delete require.cache[require.resolve(CHILD_TURN_HOOK_PATH)];
  const h = tmpHome();
  try {
    const r = testHook(CHILD_TURN_HOOK_PATH, promptPayload('sess-nudge'), {
      home: h, expectJson: true, env: makeChildEnv('child-nudge'),
    });
    assert.strictEqual(r.status, 0);
    const c = ctxText(r);
    // defect 735b179362e8 fix: RECEIVE_NUDGE now substitutes the REAL
    // DEVSWARM_BUILDER_ID (env sets it here) in place of the literal
    // placeholder — assert against the substituted id, and that the
    // placeholder no longer leaks through unsubstituted.
    assert.ok(c.includes('inbox read-primary child-nudge'), `THE FIX: RECEIVE_NUDGE must prescribe read-primary; ctx=${c}`);
    assert.ok(!c.includes('inbox read child-nudge'), `must never prescribe the unpaired non-acking form; ctx=${c}`);
    assert.ok(!c.includes('<DEVSWARM_BUILDER_ID>'), `real id was available and safe; placeholder must not leak through; ctx=${c}`);
  } finally { rm(h); }
});

test('Item 3 mutation check (RECEIVE_NUDGE): reverting to the bare `inbox read <BUILDER_ID>` form reproduces the unpaired non-acking-verb defect', () => {
  const liveBefore = fs.readFileSync(CHILD_TURN_HOOK_PATH, 'utf8');
  const oldStr = "'Then read AND ack them via `node ' + CLI + ' inbox read-primary ' +\n  '<DEVSWARM_BUILDER_ID>`. Substitute your own DEVSWARM_BUILDER_ID for <...>.';";
  assert.ok(liveBefore.includes(oldStr), 'Item 3 RECEIVE_NUDGE fix text not found verbatim');
  const buggyStr = "'Then read them the non-draining way via `node ' + CLI + ' inbox read ' +\n  '<DEVSWARM_BUILDER_ID>`. Substitute your own DEVSWARM_BUILDER_ID for <...>.';";
  const copy = scratchHookCopy('anti-hall-fixwave5-item3b');
  try {
    mutateHook(copy.hookPath, oldStr, buggyStr);
    const h = tmpHome();
    try {
      const r = testHook(copy.hookPath, promptPayload('sess-nudgem'), {
        home: h, expectJson: true, env: makeChildEnv('child-nudgem'),
      });
      assert.strictEqual(r.status, 0);
      const c = ctxText(r);
      // defect 735b179362e8 fix: id substitution runs on whatever text
      // RECEIVE_NUDGE holds (buggy or fixed) — the scratch copy still carries
      // the real substituteId()/main() logic, so the placeholder is replaced
      // here too. Assert against the substituted id, same as the GREEN test.
      assert.ok(c.includes('inbox read child-nudgem'), `BUGGY (pre-fix): must reproduce the unpaired non-acking form; ctx=${c}`);
      assert.ok(!c.includes('inbox read-primary child-nudgem'), `BUGGY: must NOT accidentally carry the fixed form; ctx=${c}`);
    } finally { rm(h); }
  } finally { discardHookCopy(copy); }
  assert.equal(fs.readFileSync(CHILD_TURN_HOOK_PATH, 'utf8'), liveBefore, 'live devswarm-child-turn.js must never be modified by a mutation test');
});
