'use strict';
// GHOST ALIAS ROW (0.108.4). Field: the SkyCrew roster showed a live
// `primary-<childhash>` row for a worktree the app gives to a real child
// builder. The label had been folded + tombstoned; then `update` (run inside
// the Primary's session) ran `reconcile`, whose per-row `inbox pull` subprocess
// ran with cwd = the child worktree but the Primary's env — auto-ensure
// re-created the label's descriptor and promoted it to the Primary's live
// session. Pins: the sweep never speaks for a session, auto-ensure redirects a
// label to the canonical id, the roster shows one row, the repair folds a label
// stamped with a foreign live session, and messages under the alias survive.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ghost-log-'));
const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const aliasLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-sender-alias.js'));
const { COLS } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skipNoSqlite = sqlite ? false : 'node:sqlite unavailable';

const CHILD = '399105fe-1111-4222-8333-444455556666';
// No `hivecontrol` on this PATH: the spawned drains must never reach a real app.
const SAFE_PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ghost-home-')));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ghost-repo-')));
  const repo = path.join(base, 'main');
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const child = path.join(base, 'fix-child');
  cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', child, '-b', 'fix-child']);
  const env = { ANTIHALL_DEVSWARM_APP_DB: 'off', PATH: SAFE_PATH, ANTI_HALL_LOG_DIR: process.env.ANTI_HALL_LOG_DIR };
  return {
    home, base, repo, child, env,
    repoKey: repokey.repoKeyForWorktree(repo),
    PRIMARY: inst.primaryWorkspaceId(repo),
    LABEL: inst.primaryWorkspaceId(child),
  };
}
function cleanup(f) { rm(f.home); rm(f.base); }
function withStore(f, fn) {
  const s = storeLib.openStore({ home: f.home, hash: f.repoKey });
  try { return fn(s); } finally { s.close(); }
}
const dsDir = (f, sub) => path.join(f.home, '.anti-hall', 'devswarm', sub);
const descPath = (f, id) => path.join(dsDir(f, 'workspaces'), id + '.json');
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }
function registerPrimary(f) {
  const r = cli.run(['register-primary'], { home: f.home, env: Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-primary' }, f.env), cwd: f.repo });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
}
function registerChild(f) {
  withStore(f, (s) => s.upsertRegistry({ id: CHILD, worktreePath: f.child, sessionId: 'sess-child' }));
  writeJson(descPath(f, CHILD), { id: CHILD, worktreePath: f.child, sessionId: 'sess-child', ownerKey: f.repoKey, repoKey: f.repoKey });
}
function sendDirect(f, to, body) {
  withStore(f, (s) => {
    const fields = { from: f.PRIMARY, to, type: 'direct', message: body, timestamp: Date.now(), urgency: 'normal' };
    storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
  });
}
function registryRow(f, id) { return withStore(f, (s) => (s.listRegistry() || []).find((r) => String(r.id) === id) || null); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function appDbEnv(dir, builders) {
  const file = path.join(dir, 'app-' + Math.random().toString(16).slice(2) + '.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE builders (' + COLS.builders + ')');
  db.exec('CREATE TABLE builder_terminals (' + COLS.builder_terminals + ')');
  for (const b of builders) {
    db.prepare('INSERT INTO builders (id, worktreePath, builderType, isActive, isHidden, label) VALUES (?, ?, ?, 1, 0, ?)').run(b.id, b.wt, b.type, b.label || b.id);
  }
  db.close();
  return { ANTIHALL_DEVSWARM_APP_DB: file, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
}

test('root cause: a Primary-session reconcile never stamps its session onto a child worktree row', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    // The child's worktree label, unclaimed (spawn-seed shape), no child id yet —
    // so only the reconcile-env fix stands between it and the Primary's session.
    withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: f.child, sessionId: null }));
    writeJson(descPath(f, f.LABEL), { id: f.LABEL, worktreePath: f.child, sessionId: 'unclaimed:' + f.LABEL, ownerKey: f.repoKey, repoKey: f.repoKey });
    const env = Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-primary', DEVSWARM_BUILDER_ID: 'hive-primary' }, f.env);
    const r = cli.run(['reconcile'], { home: f.home, env, cwd: f.repo });
    const labelRes = (r.result.results || []).find((x) => x.id === f.LABEL);
    assert.ok(labelRes, 'the label row was swept: ' + JSON.stringify(r.result));
    const d = readJson(descPath(f, f.LABEL));
    assert.equal(d.sessionId, 'unclaimed:' + f.LABEL, 'descriptor keeps the unclaimed marker');
    const row = registryRow(f, f.LABEL);
    assert.ok(!row || !['sess-primary', 'hive-primary'].includes(String(row.sessionId)), 'registry not stamped: ' + JSON.stringify(row));
    // The Primary's own anchor is untouched by the sweep.
    assert.equal(registryRow(f, f.PRIMARY).sessionId, 'sess-primary');
  } finally { cleanup(f); }
});

test('auto-ensure: `inbox pull <retired label>` redirects to the canonical id and mints no descriptor; heartbeat is refused', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChild(f);
    writeJson(path.join(dsDir(f, 'retired'), f.LABEL + '.json'), { retiredTo: CHILD, at: Date.now() });
    const pullRes = cli.run(['inbox', 'pull', f.LABEL], { home: f.home, env: Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-primary' }, f.env), cwd: f.child });
    assert.equal(pullRes.result.id, CHILD, JSON.stringify(pullRes.result));
    assert.equal(pullRes.result.redirectedFrom, f.LABEL);
    assert.ok(!fs.existsSync(descPath(f, f.LABEL)), 'no live descriptor under the retired label');
    assert.equal(registryRow(f, f.LABEL), null, 'no registry row under the retired label');
    // No row, no --worktree, caller on the Primary checkout: the redirect alone refuses it.
    const hb = cli.run(['heartbeat', f.LABEL], { home: f.home, env: f.env, cwd: f.repo });
    assert.equal(hb.result.reason, 'child-label-id', JSON.stringify(hb.result));
    assert.equal(hb.result.resolvedTo, CHILD);
    assert.equal(registryRow(f, f.LABEL), null);
  } finally { cleanup(f); }
});

test('roster: a live label row folds into its child (alias) — one row, unread carried', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChild(f);
    withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: f.child, sessionId: 'sess-primary' }));
    sendDirect(f, f.LABEL, 'reply under the alias');
    const before = cli.run(['roster'], { home: f.home, env: f.env, cwd: f.repo }).result;
    assert.ok(before.workspaces.some((w) => w.id === f.LABEL), 'unaliased: the label row is shown');
    aliasLib.writeAlias(f.home, f.LABEL, CHILD, f.child);
    const after = cli.run(['roster'], { home: f.home, env: f.env, cwd: f.repo }).result;
    const ids = after.workspaces.map((w) => w.id);
    assert.ok(!ids.includes(f.LABEL), 'ghost row gone: ' + JSON.stringify(ids));
    assert.equal(ids.filter((x) => x === CHILD).length, 1, 'the child shows exactly once');
    const c = after.workspaces.find((w) => w.id === CHILD);
    assert.deepEqual(c.foldedAliases, [f.LABEL]);
    const beforeChild = before.workspaces.find((w) => w.id === CHILD);
    const beforeLabel = before.workspaces.find((w) => w.id === f.LABEL);
    assert.ok(beforeLabel.directUnread >= 1, JSON.stringify(beforeLabel));
    assert.equal(c.directUnread, beforeChild.directUnread + beforeLabel.directUnread, 'alias unread carried into the child row');
    assert.ok(ids.includes(f.PRIMARY), 'the genuine Primary row is kept');
  } finally { cleanup(f); }
});

test('roster: a ghost folding into a canonical row whose directUnread is null (archived child) still carries its unread and hints; the roster unread total is unchanged by the fold', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChild(f);
    const arch = cli.run(['archive', CHILD], { home: f.home, env: f.env, cwd: f.repo }).result;
    assert.equal(arch.ok, true, JSON.stringify(arch));
    // the ghost's worktree path is gone on disk -> it carries a 'worktree-gone' hint
    withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: path.join(f.base, 'gone-wt'), sessionId: 'sess-primary' }));
    sendDirect(f, f.LABEL, 'reply under the alias to an archived child');
    const total = (r) => r.workspaces.reduce((n, w) => n + (Number.isFinite(w.directUnread) ? w.directUnread : 0), 0);
    const before = cli.run(['roster'], { home: f.home, env: f.env, cwd: f.repo }).result;
    const beforeChild = before.workspaces.find((w) => w.id === CHILD);
    const beforeLabel = before.workspaces.find((w) => w.id === f.LABEL);
    assert.ok(beforeChild && beforeChild.directUnread === null, 'precondition: archived canonical row has null unread: ' + JSON.stringify(beforeChild));
    assert.ok(beforeLabel && beforeLabel.directUnread >= 1, JSON.stringify(beforeLabel));
    aliasLib.writeAlias(f.home, f.LABEL, CHILD, f.child);
    const after = cli.run(['roster'], { home: f.home, env: f.env, cwd: f.repo }).result;
    const c = after.workspaces.find((w) => w.id === CHILD);
    assert.ok(!after.workspaces.some((w) => w.id === f.LABEL), 'ghost row folded');
    assert.equal(c.directUnread, beforeLabel.directUnread, 'ghost unread carried into the null canonical row: ' + JSON.stringify(c));
    assert.ok((beforeLabel.hints || []).length >= 1, 'precondition: ghost has hints: ' + JSON.stringify(beforeLabel));
    for (const h of beforeLabel.hints) assert.ok(c.hints.includes(h), 'ghost hint ' + h + ' carried: ' + JSON.stringify(c.hints));
    assert.ok(c.hints.includes('archived'), 'canonical hints kept');
    assert.equal(total(after), total(before), 'roster unread total unchanged by the fold');
  } finally { cleanup(f); }
});

test('roster: the app DB owning the label worktree under another builder folds the label (no alias, no redirect)', { skip: skipNoSqlite }, () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChild(f);
    withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: f.child, sessionId: 'sess-primary' }));
    const env = Object.assign({}, f.env, appDbEnv(f.base, [
      { id: 'b-primary', wt: f.repo, type: 'primary' },
      { id: CHILD, wt: f.child, type: 'standard' },
    ]));
    const ids = cli.run(['roster'], { home: f.home, env, cwd: f.repo }).result.workspaces.map((w) => w.id);
    assert.ok(!ids.includes(f.LABEL), JSON.stringify(ids));
    assert.equal(ids.filter((x) => x === CHILD).length, 1);
    assert.ok(ids.includes(f.PRIMARY), 'a primary-type builder never folds the Primary anchor');
    const plain = cli.run(['roster'], { home: f.home, env: f.env, cwd: f.repo }).result.workspaces.map((w) => w.id);
    assert.ok(plain.includes(f.LABEL), 'without the app DB proof the row is not hidden');
  } finally { cleanup(f); }
});

test('repair (seeded bad state): a label live under a FOREIGN session folds into the child; descriptor moved, messages kept; idempotent', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChild(f);
    // Field shape: the label row + descriptor carry the Primary's live session.
    withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: f.child, sessionId: 'sess-primary' }));
    writeJson(descPath(f, f.LABEL), { id: f.LABEL, worktreePath: f.child, sessionId: 'sess-primary', ownerKey: f.repoKey, repoKey: f.repoKey });
    writeJson(path.join(dsDir(f, 'archived'), f.LABEL + '.json'), { id: f.LABEL, worktreePath: f.child, sessionId: 'unclaimed:' + f.LABEL, archivedBy: 'child-sender-label-repair', retiredTo: CHILD });
    writeJson(path.join(f.home, '.claude', 'sessions', 'p.json'), { pid: process.pid, sessionId: 'sess-primary', cwd: f.repo });
    sendDirect(f, f.LABEL, 'mail sent to the alias');

    const res = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env });
    assert.equal(res.errors, 0, JSON.stringify(res));
    assert.equal(res.retired, 1, JSON.stringify(res));
    assert.deepEqual(res.left, []);
    assert.equal(registryRow(f, f.LABEL), null, 'label row tombstoned');
    assert.ok(registryRow(f, CHILD) && registryRow(f, f.PRIMARY), 'child + Primary untouched');
    assert.ok(!fs.existsSync(descPath(f, f.LABEL)), 'live descriptor moved out of workspaces/');
    const moved = fs.readdirSync(dsDir(f, 'archived-retired')).filter((n) => n.startsWith(f.LABEL + '.'));
    assert.equal(moved.length, 1, 'moved, not deleted');
    assert.equal(readJson(path.join(dsDir(f, 'archived-retired'), moved[0])).sessionId, 'sess-primary');
    assert.equal(readJson(path.join(dsDir(f, 'retired'), f.LABEL + '.json')).retiredTo, CHILD);
    // Messages: forwarded into the child partition AND still readable under the alias.
    assert.deepEqual(withStore(f, (s) => s.listMessages(CHILD).map((m) => m.body)), ['mail sent to the alias']);
    assert.deepEqual(withStore(f, (s) => s.listMessages(f.LABEL).map((m) => m.body)), ['mail sent to the alias'], 'original row kept');
    const viaAlias = cli.run(['inbox', 'messages', f.LABEL], { home: f.home, env: f.env, cwd: f.repo }).result;
    assert.ok(JSON.stringify(viaAlias).includes('mail sent to the alias'), JSON.stringify(viaAlias));
    // Idempotent.
    const again = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env, dryRun: true });
    assert.equal(again.pending, 0, JSON.stringify(again));
    const ids = cli.run(['roster'], { home: f.home, env: f.env, cwd: f.repo }).result.workspaces.map((w) => w.id);
    assert.ok(!ids.includes(f.LABEL) && ids.includes(CHILD), 'roster: one row after the repair ' + JSON.stringify(ids));
  } finally { cleanup(f); }
});

test('repair: a label held by a live session ON its own worktree is still left (never retired under its own runner)', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChild(f);
    withStore(f, (s) => s.upsertRegistry({ id: f.LABEL, worktreePath: f.child, sessionId: 'sess-own' }));
    writeJson(path.join(f.home, '.claude', 'sessions', 'o.json'), { pid: process.pid, sessionId: 'sess-own', cwd: f.child });
    const res = cli.repairChildSenderLabelsAllStores(f.home, { env: f.env });
    assert.equal(res.retired, 0, JSON.stringify(res));
    assert.deepEqual(res.left.map((x) => x.reason), ['child-label-live']);
    assert.ok(registryRow(f, f.LABEL));
  } finally { cleanup(f); }
});

test('genuine Primary: register-primary, own pull, heartbeat and roster row all still work', () => {
  const f = fixture();
  try {
    registerPrimary(f);
    registerChild(f);
    writeJson(path.join(dsDir(f, 'retired'), f.LABEL + '.json'), { retiredTo: CHILD, at: Date.now() });
    const env = Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-primary' }, f.env);
    const p = cli.run(['inbox', 'pull', f.PRIMARY], { home: f.home, env, cwd: f.repo }).result;
    assert.equal(p.id, f.PRIMARY, JSON.stringify(p));
    assert.equal(p.redirectedFrom, undefined);
    assert.equal(cli.run(['heartbeat', f.PRIMARY], { home: f.home, env, cwd: f.repo }).result.ok, true);
    assert.equal(registryRow(f, f.PRIMARY).sessionId, 'sess-primary');
    const ids = cli.run(['roster'], { home: f.home, env, cwd: f.repo }).result.workspaces.map((w) => w.id);
    assert.ok(ids.includes(f.PRIMARY) && ids.includes(CHILD), JSON.stringify(ids));
  } finally { cleanup(f); }
});
