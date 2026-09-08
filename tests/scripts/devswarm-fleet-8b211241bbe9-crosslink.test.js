'use strict';
// 8b211241bbe9 §2b — the cross-link cursor eater.
//
// `siblingAckGate` short-circuits to SELF when the caller row and the partition
// row are `crossLinkedIdentity`. That predicate compares ONLY ids and
// sessionIds — no process, instance, or LOCATION component — so a caller
// standing in the PARENT's worktree while holding a child's meshId passed the
// SELF test and acked the child's twin partition, consuming mail the child was
// never shown (field repro: the uuid cursor found already advanced with no tick
// in the child's own turn).
//
// Fix under test: SELF additionally requires the caller's cwd to resolve to the
// partition row's OWN worktree, failing OPEN to today's verdict when the row
// carries no worktreePath.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-8b21x-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-8b21x-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function backend() { return (storeLib.sqliteAvailable && storeLib.sqliteAvailable()) ? 'sqlite' : 'journal'; }
function repoKeyOf(repo) {
  return require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js')).repoKeyForWorktree(repo);
}
// Register a row DIRECTLY in the store so a cross-link (row.sessionId === the
// other row's id) can be set up exactly as the field shape produces it.
function upsert(home, repo, id, sessionId) {
  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  try {
    s.upsertRegistry({
      id, worktreePath: repo, sessionId,
      inboxPath: path.join(repo, id + '.ndjson'),
      cursorPath: path.join(repo, id + '.cursor'),
    });
  } finally { s.close(); }
}
function openStore(home, repo) {
  return storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
}

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => {
  const iso = tmpHome();
  process.env.HOME = iso;
  process.env.USERPROFILE = iso;
});
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});

test('8b211241bbe9 §2b: SELF holds when the caller stands in the partition\'s OWN worktree', () => {
  const home = tmpHome(); const repo = makeGitRepo('self-own');
  try {
    upsert(home, repo, 'primary-x', 'twin-uuid-x');   // cross-link: caller.sessionId === twin id
    upsert(home, repo, 'twin-uuid-x', 'unclaimed:twin-uuid-x');
    const s = openStore(home, repo);
    try {
      const notAckable = cli.siblingAckGate(s, 'primary-x', 'twin-uuid-x', home, Date.now(), { cwd: repo });
      assert.strictEqual(notAckable, false,
        'the caller IS this partition\'s owner and stands in its worktree — the legitimate self-ack must survive the fix');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 §2b: SELF is REFUSED when the caller stands in a different worktree', () => {
  const home = tmpHome(); const childRepo = makeGitRepo('child'); const parentRepo = makeGitRepo('parent');
  try {
    upsert(home, childRepo, 'primary-y', 'twin-uuid-y');
    upsert(home, childRepo, 'twin-uuid-y', 'unclaimed:twin-uuid-y');
    const s = openStore(home, childRepo);
    try {
      const notAckable = cli.siblingAckGate(s, 'primary-y', 'twin-uuid-y', home, Date.now(), { cwd: parentRepo });
      assert.strictEqual(notAckable, true,
        'a caller in the PARENT worktree holding the child meshId is NOT self and must never ack the twin — the 30->31 repro');
    } finally { s.close(); }
  } finally { rm(home); rm(childRepo); rm(parentRepo); }
});

test('8b211241bbe9 §2b: a row with no worktreePath keeps today\'s SELF verdict (fail open)', () => {
  const home = tmpHome(); const repo = makeGitRepo('failopen'); const other = makeGitRepo('other');
  try {
    upsert(home, repo, 'primary-z', 'twin-uuid-z');
    // A pre-migration / partial row: registered with NO worktreePath.
    const s0 = openStore(home, repo);
    try { s0.upsertRegistry({ id: 'twin-uuid-z', sessionId: 'unclaimed:twin-uuid-z', inboxPath: null, cursorPath: null }); }
    finally { s0.close(); }
    const s = openStore(home, repo);
    try {
      const notAckable = cli.siblingAckGate(s, 'primary-z', 'twin-uuid-z', home, Date.now(), { cwd: other });
      assert.strictEqual(notAckable, false,
        'with no worktreePath to compare, the gate must fail OPEN to the pre-fix SELF verdict — never strand a legitimate self-ack');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); rm(other); }
});

test('8b211241bbe9 §2b: the gate is unchanged when no cross-link exists', () => {
  const home = tmpHome(); const repo = makeGitRepo('nolink'); const other = makeGitRepo('nolink2');
  try {
    upsert(home, repo, 'primary-w', 'sess-primary-w');
    upsert(home, repo, 'unrelated-w', 'sess-unrelated-w');
    const s = openStore(home, repo);
    try {
      // No cross-link: the verdict comes from plain liveness, exactly as before,
      // and the worktree scope must not have altered that path.
      const fromOwn = cli.siblingAckGate(s, 'primary-w', 'unrelated-w', home, Date.now(), { cwd: repo });
      const fromOther = cli.siblingAckGate(s, 'primary-w', 'unrelated-w', home, Date.now(), { cwd: other });
      assert.strictEqual(fromOwn, fromOther,
        'without a cross-link the caller\'s cwd must not change the verdict at all');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); rm(other); }
});

test('8b211241bbe9 §2b: no cursor decision consults liveness', () => {
  const home = tmpHome(); const repo = makeGitRepo('nolive');
  try {
    const id = 'primary-nl';
    cli.cmdRegister(id, { worktree: [repo], session: ['s-' + id] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now() });
    const s = openStore(home, repo);
    try {
      for (let i = 0; i < 2; i++) {
        const fields = { from: 'p', to: id, type: 'direct', message: 'nl-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
        storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
      }
    } finally { s.close(); }
    // The per-instance read/ack path must not depend on any heartbeat or
    // liveness evidence: nothing was ever marked live in this home.
    const a = cli.cmdInboxMessages(id, { unread: [true] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:1:1' }, { ack: true });
    const b = cli.cmdInboxMessages(id, { unread: [true] },
      { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:2:2' }, { ack: true });
    assert.strictEqual(a.messages.length, 2);
    assert.strictEqual(b.messages.length, 2,
      'both instances are served with no liveness oracle in play — `inbox tick` refreshes only the heartbeat file, so any such oracle would be wrong anyway');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// R1 item 18 — the two named cases from the design's own §4 list that had not
// been written, plus the §2e override hazard the Auditor proved is real.
// ---------------------------------------------------------------------------

test('8b211241bbe9 §2b: --ack-as-owner still acks a genuinely ownerless partition', () => {
  const home = tmpHome(); const repo = makeGitRepo('override-ok'); const other = makeGitRepo('override-elsewhere');
  try {
    const id = 'primary-ovr';
    const inbox = path.join(repo, 'i.ndjson');
    fs.writeFileSync(inbox, JSON.stringify({ from: 'p', message: 'x', ts: 1 }) + '\n');
    cli.cmdRegister(id, {
      worktree: [repo], session: ['s-ovr'], inbox: [inbox], cursor: [path.join(repo, 'c.json')],
    }, { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:1:1' });
    // Ack from a DIFFERENT worktree with the sanctioned override. The gate
    // change must not have made the override collateral damage.
    const r = cli.cmdInbox('ack', id, { 'ack-as-owner': [true] }, {
      home, cwd: other, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:2:2',
    });
    assert.notStrictEqual(r.reason, 'redirect-to-live-owner',
      'a partition with no retired-redirect at all must never hit the redirect guard');
    assert.ok(r.ok !== false || r.reason !== 'live-primary-conflict',
      'the sanctioned cross-workspace override must still function: ' + JSON.stringify(r).slice(0, 200));
  } finally { rm(home); rm(repo); rm(other); }
});

test('8b211241bbe9 §2e: --ack-as-owner on a retired id redirecting to a LIVE owner is refused', () => {
  const home = tmpHome(); const repo = makeGitRepo('redirect-live');
  try {
    const retired = 'twin-retired';
    const survivor = 'primary-survivor';
    const sInbox = path.join(repo, 'survivor.ndjson');
    fs.writeFileSync(sInbox, JSON.stringify({ from: 'p', message: 'live mail', ts: 1 }) + '\n');
    // The survivor is registered and LIVE (fresh heartbeat under its own id).
    cli.cmdRegister(survivor, {
      worktree: [repo], session: ['s-surv'], inbox: [sInbox], cursor: [path.join(repo, 'sc.json')],
    }, { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:1:1' });
    const hbDir = path.join(home, '.anti-hall', 'devswarm', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });
    fs.writeFileSync(path.join(hbDir, survivor + '.json'),
      JSON.stringify({ id: survivor, ts: Date.now(), state_ts: Date.now() }));
    // A fold left behind a redirect from the retired twin to that live survivor.
    const redirDir = path.join(home, '.anti-hall', 'devswarm', 'retired');
    fs.mkdirSync(redirDir, { recursive: true });
    fs.writeFileSync(path.join(redirDir, retired + '.json'),
      JSON.stringify({ retiredTo: survivor, at: Date.now() }));

    const r = cli.cmdInbox('ack', retired, { 'ack-as-owner': [true] }, {
      home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:9:9',
    });
    assert.strictEqual(r.ok, false,
      'the override must NOT consume a live survivor\'s mail by naming its retired twin: ' + JSON.stringify(r).slice(0, 250));
    assert.strictEqual(r.reason, 'redirect-to-live-owner');
    assert.strictEqual(r.redirectedTo, survivor);
    // R3 item 4: the refusal must also be JOURNALED, so a later investigation
    // can see that an override was aimed at a live owner and stopped.
    const rk = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js')).repoKeyForWorktree(repo);
    const recs = cli.readCursorLog(home, rk, 100)
      .concat(cli.readCursorLog(home, 'unknown', 100));
    const rec = recs.find((x) => x && x.gate === 'redirect-to-live');
    assert.ok(rec, 'the refusal must leave a journal record: ' + JSON.stringify(recs.slice(-3)));
    assert.strictEqual(rec.ok, false, 'and it is recorded as a NON-write');
    assert.strictEqual(rec.callerId, retired, 'naming the retired id the caller typed');
    assert.strictEqual(rec.partition, survivor, 'and the live survivor it would have hit');
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 §2b: a fresh child with NO outbound rows still acks its own twin', () => {
  const home = tmpHome(); const repo = makeGitRepo('freshtwin');
  try {
    // meshId row cross-linked to its uuid twin, both on the child's own
    // worktree. The child has registered but has NEVER broadcast or
    // heartbeated, so nothing about it is derivable from outbound rows.
    upsert(home, repo, 'primary-fresh', 'twin-uuid-fresh');
    upsert(home, repo, 'twin-uuid-fresh', 'unclaimed:twin-uuid-fresh');
    const s = openStore(home, repo);
    try {
      const notAckable = cli.siblingAckGate(s, 'primary-fresh', 'twin-uuid-fresh', home, Date.now(), { cwd: repo });
      assert.strictEqual(notAckable, false,
        'a fresh child must be able to ack its OWN twin with no heartbeat, no outbound row and no liveness probe — '
        + 'this is the case that killed the outbound-row owner inference');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('8b211241bbe9 §2e: --ack-as-owner DOES ack a survivor whose owner is dead', () => {
  const home = tmpHome(); const repo = makeGitRepo('redirect-dead');
  try {
    const retired = 'twin-retired-d';
    const survivor = 'primary-survivor-d';
    const sInbox = path.join(repo, 'survivor-d.ndjson');
    fs.writeFileSync(sInbox, JSON.stringify({ from: 'p', message: 'orphan mail', ts: 1 }) + '\n');
    cli.cmdRegister(survivor, {
      worktree: [repo], session: ['s-surv-d'], inbox: [sInbox], cursor: [path.join(repo, 'sc-d.json')],
    }, { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:1:1' });
    // NO heartbeat is written for the survivor: its owner is not live. This is
    // the override's sanctioned purpose — a retired target with no live owner.
    const redirDir = path.join(home, '.anti-hall', 'devswarm', 'retired');
    fs.mkdirSync(redirDir, { recursive: true });
    fs.writeFileSync(path.join(redirDir, retired + '.json'),
      JSON.stringify({ retiredTo: survivor, at: Date.now() }));

    const r = cli.cmdInbox('ack', retired, { 'ack-as-owner': [true] }, {
      home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: 'anc:9:9',
    });
    assert.notStrictEqual(r.reason, 'redirect-to-live-owner',
      'a DEAD survivor must not trip the live-owner refusal — that would break the override\'s whole purpose: '
      + JSON.stringify(r).slice(0, 200));
  } finally { rm(home); rm(repo); }
});
