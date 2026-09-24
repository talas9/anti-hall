'use strict';
// v0.108.0 screenshot sync (#37): planUiSync (pure) + `sync-ui` verb + the
// parent-inbox "send a screenshot" ask.
//   planUiSync: prefix / "…" both sides, duplicates -> visible -> position tiebreak
//   -> ambiguous, partial list archives nothing active, app DB off -> 0 archives
//   (all unknown), both conflict kinds, Primary excluded, title updates carry
//   the FULL app label
//   sync-ui: dry run writes nothing; conflicts refuse --yes; --yes marks +
//   renames, is idempotent, never deletes; { before, after, diff } shape
//   parent-inbox: the ask appears once per session per set, only on conflict /
//   unreadable app DB

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const ui = require(path.join(ROOT, 'companion', 'lib', 'devswarm-ui-sync.js'));
const appDb = require(path.join(ROOT, 'companion', 'lib', 'devswarm-app-db.js'));
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const names = require(path.join(ROOT, 'companion', 'lib', 'devswarm-names.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const { testHook } = require('../helpers/spawn-hook.js');
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

const ws = (id, label, extra) => Object.assign({ id, label, repositoryId: 'r', builderType: 'standard', rank: 0, isHidden: false, active: true, archived: false }, extra || {});

test('normTitle / titleMatches: NFKC, whitespace, trailing ellipsis on both sides, >= 12 shared chars', () => {
  assert.strictEqual(ui.normTitle('  Fix   the ＡＰＩ layer…'), 'fix the api layer');
  assert.ok(ui.titleMatches('Airalo auto-refunds all f…', 'Airalo auto-refunds all fail 422: RCA + owner-gated fix'));
  assert.ok(ui.titleMatches('Airalo auto-refunds all fail 422: RCA + owner-gated fix', 'Airalo auto-refunds all f…'), 'stored label truncated too');
  assert.ok(!ui.titleMatches('Airalo…', 'Airalo auto-refunds'), 'fewer than 12 shared chars is no match');
  assert.ok(ui.titleMatches('Short', 'short'), 'exact equality always matches');
});

test('planUiSync: matches, tiebreaks, safety rules', () => {
  const snap = { workspaces: [
    ws('p', 'Primary Workspace', { builderType: 'primary' }),
    ws('a', 'Alpha feature for the checkout flow', { rank: 0 }),
    ws('d1', 'Duplicate title for the report', { rank: 1 }),
    ws('d2', 'Duplicate title for the report', { rank: 2 }),
    ws('h', 'Hidden twin of the alpha feature', { rank: 5, isHidden: true, active: false, archived: true }),
    ws('x', 'Archived in the app already', { rank: 9, isHidden: true, active: false, archived: true }),
    ws('o', 'Open but not in the screenshot', { rank: 3 }),
    ws('other', 'Alpha feature for the checkout flow', { repositoryId: 'r2' }),
  ] };
  const plan = ui.planUiSync({
    titles: ['Alpha feature for the ch…', 'Duplicate title for the…', 'Duplicate title for the…', 'Hidden twin of the alpha feature', 'Primary Workspace', 'Nothing like this'],
    snapshot: snap, repositoryId: 'r',
    descriptors: [{ id: 'a' }, { id: 'x' }, { id: 'o' }, { id: 'h' }],
    markers: ['o'],
    names: { a: 'Alpha feature for the ch…' },
  });
  assert.deepStrictEqual(plan.matched.map((m) => m.id), ['a', 'd1', 'd2', 'h'], 'position tiebreak resolves the duplicate titles');
  assert.deepStrictEqual(plan.unmatched, ['Primary Workspace', 'Nothing like this'], 'Primary excluded');
  assert.deepStrictEqual(plan.toArchive.map((t) => t.id), ['x'], 'only app-archived + absent; open-but-absent kept');
  assert.deepStrictEqual(plan.conflicts.map((c) => c.id + ':' + c.kind).sort(), ['h:visible-but-app-archived', 'o:marker-but-app-active']);
  const upd = plan.titleUpdates.find((u) => u.id === 'a');
  assert.strictEqual(upd.to, 'Alpha feature for the checkout flow', 'full app label, never the screenshot text');
  const amb = ui.planUiSync({ titles: ['Duplicate title for the…'], snapshot: snap, repositoryId: 'r', descriptors: [], markers: [], names: {} });
  assert.strictEqual(amb.ambiguous.length, 1, 'still tied at a non-matching position -> ambiguous');
  const off = ui.planUiSync({ titles: ['Alpha feature for the ch…'], snapshot: null, descriptors: [{ id: 'a' }, { id: 'x' }], markers: [] });
  assert.deepStrictEqual(off.toArchive, [], 'app DB unreadable -> archive nothing');
  assert.deepStrictEqual(off.unknown, ['a', 'x']);
  const partial = ui.planUiSync({ titles: [], snapshot: snap, repositoryId: 'r', descriptors: [{ id: 'a' }, { id: 'o' }], markers: [] });
  assert.deepStrictEqual(partial.toArchive, [], 'an empty/partial list archives nothing active');
});

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); }
  })(dir);
  return out.sort();
}
function verbFixture() {
  const f = buildAppDb();
  cp.spawnSync('git', ['init', '-q', f.repoPath]);
  const wsDir = path.join(f.home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(wsDir, { recursive: true });
  for (const [id, wt] of [['b-a', f.wt.a], ['b-arch', f.wt.arch]]) fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify({ id, worktreePath: wt }));
  names.writeName(f.home, 'b-a', 'Alpha task with a long full…', Date.now());
  const titles = path.join(f.base, 'titles.json');
  fs.writeFileSync(titles, JSON.stringify(['Bravo task', 'Alpha task with a long full title that is…']));
  return { f, titles };
}

test('sync-ui verb: dry run writes nothing; --yes marks + renames; idempotent; never deletes', { skip }, () => {
  const { f, titles } = verbFixture();
  try {
    const ctx = { home: f.home, env: f.env, cwd: f.repoPath };
    const before = listFiles(f.home);
    const dry = dw.run(['sync-ui', '--titles-json', titles], ctx).result;
    assert.strictEqual(dry.ok, true, JSON.stringify(dry));
    assert.strictEqual(dry.dryRun, true);
    assert.deepStrictEqual(dry.plan.matched.map((m) => m.id), ['b-b', 'b-a']);
    assert.deepStrictEqual(dry.plan.toArchive.map((t) => t.id), ['b-arch']);
    assert.ok(dry.before.some((r) => r.id === 'b-arch' && r.app === 'archived' && r.antiHall === 'active'));
    assert.deepStrictEqual(listFiles(f.home), before, 'dry run writes nothing');

    const yes = dw.run(['sync-ui', '--titles-json', titles, '--yes'], ctx).result;
    assert.strictEqual(yes.ok, true, JSON.stringify(yes));
    assert.deepStrictEqual(yes.diff.archived, ['b-arch']);
    assert.deepStrictEqual(yes.diff.renamed.sort(), ['b-a', 'b-b']);
    assert.strictEqual(names.readName(f.home, 'b-a'), 'Alpha task with a long full title that is well past sixty characters in length');
    assert.ok(yes.after.some((r) => r.id === 'b-arch' && r.antiHall === 'archived'));
    for (const p of before) assert.ok(listFiles(f.home).includes(p), 'nothing deleted: ' + p);
    const again = dw.run(['sync-ui', '--titles-json', titles, '--yes'], ctx).result;
    assert.deepStrictEqual(again.diff, { archived: [], renamed: [], errors: [] }, 'idempotent');
  } finally { rmFixture(f); }
});

test('sync-ui verb: a conflict refuses --yes until --accept-conflicts; bad input is an error', { skip }, () => {
  const { f, titles } = verbFixture();
  try {
    const ctx = { home: f.home, env: f.env, cwd: f.repoPath };
    const ad = path.join(f.home, '.anti-hall', 'devswarm', 'archived');
    fs.mkdirSync(ad, { recursive: true });
    fs.writeFileSync(path.join(ad, 'b-a.json'), JSON.stringify({ id: 'b-a', worktreePath: f.wt.a }));
    const r = dw.run(['sync-ui', '--titles-json', titles, '--yes'], ctx);
    assert.strictEqual(r.result.ok, false);
    assert.strictEqual(r.result.reason, 'conflicts');
    assert.ok(!fs.existsSync(path.join(ad, 'b-arch.json')), 'refused run applies nothing');
    const ok = dw.run(['sync-ui', '--titles-json', titles, '--yes', '--accept-conflicts'], ctx).result;
    assert.strictEqual(ok.ok, true);
    assert.ok(fs.existsSync(path.join(ad, 'b-a.json')), 'the conflicting marker is never removed (no auto-unarchive)');
    const bad = path.join(f.base, 'bad.json');
    fs.writeFileSync(bad, '{"nope":1}');
    assert.strictEqual(dw.run(['sync-ui', '--titles-json', bad], ctx).result.ok, false);
    assert.strictEqual(dw.run(['sync-ui'], ctx).result.ok, false);
  } finally { rmFixture(f); }
});

test('parent-inbox asks for a screenshot once per session per set, only on conflict', { skip }, () => {
  const f = buildAppDb();
  try {
    const REPO_CWD = process.cwd();
    const KEY = repokey.repoKeyForWorktree(REPO_CWD);
    const ds = path.join(f.home, '.anti-hall', 'devswarm');
    fs.mkdirSync(path.join(ds, 'summaries'), { recursive: true });
    const plain = path.join(f.base, 'plain-b'); fs.mkdirSync(plain);
    fs.writeFileSync(path.join(ds, 'summaries', KEY + '.json'), JSON.stringify({
      generatedAt: Date.now(), requiredGates: ['done'], recent: [], archivedRegistryRows: [],
      workspaces: { 'b-b': { worktreePath: plain, sessionId: null, total: 0, cursor: 0, unread: 0, directUnread: 0, gates: {}, archive_ready: false } },
    }));
    const run = (sid) => {
      const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi', cwd: REPO_CWD },
        { home: f.home, env: Object.assign({ DEVSWARM_REPO_ID: 'repo-1' }, f.env), expectJson: true });
      return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
    };
    assert.ok(!/DEVSWARM SYNC/.test(run('s1')), 'no conflict -> no ask');
    fs.writeFileSync(path.join(ds, 'app-state.json'), JSON.stringify({ v: 1, at: Date.now(), ok: true, openButMarkedArchived: [{ id: 'b-a', label: 'Alpha task' }] }));
    const first = run('s1');
    assert.ok(/DEVSWARM SYNC: The DevSwarm app shows 'Alpha task' as open, but anti-hall has it archived/.test(first), first);
    assert.ok(!/DEVSWARM SYNC/.test(run('s1')), 'once per session per set');
    assert.ok(/DEVSWARM SYNC/.test(run('s2')), 'a new session asks again');
  } finally { rmFixture(f); appDb.resetCache(); }
});
