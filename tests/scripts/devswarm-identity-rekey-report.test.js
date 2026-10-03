'use strict';
// identity-rekey-candidates (mesh redesign Phase 2 B1) — the READ-ONLY doctor
// report of stores written under a submodule's legacy repoKey, plus the realpath
// registry path guard. Real git fixture (tests/helpers/git-fixtures.js), isolated
// HOME per test, called in-process with an explicit `home` (never the real one).
// The OLD key each store is seeded under comes from the FROZEN v0.103.0 resolver
// (tests/helpers/legacy-repokey-0.103.0.js), i.e. exactly what legacy wrote.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildIdentityFixtures } = require('../helpers/git-fixtures.js');
const legacyRepokey = require('../helpers/legacy-repokey-0.103.0.js');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const devswarm = require(path.join(PLUGIN, 'scripts', 'devswarm.js'));
const store = require(path.join(PLUGIN, 'companion', 'lib', 'devswarm-store.js'));
const identity = require(path.join(PLUGIN, 'companion', 'lib', 'identity.js'));

const ENV = { ANTIHALL_INGEST_DRY_RUN: '1' };
const BACKENDS = ['journal'].concat(store.sqliteAvailable() ? ['sqlite'] : []);

let fx;
before(() => { fx = buildIdentityFixtures(); });
after(() => { if (fx) fx.cleanup(); });

function mkHome(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rekey-' + tag + '-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      out[path.relative(dir, p)] = st.size + ':' + st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

function send(s, fields) {
  const f = Object.assign({ urgency: 'normal' }, fields);
  return store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
}

const doctorRepair = require(path.join(PLUGIN, 'hooks', 'lib', 'doctor-repair.js'));
const KINDS = ['wt/libs/sub', 'wt/libs/sub/inner', 'main/vend/raw', 'main/emb', 'subwt'];

for (const backend of BACKENDS) {
  test(`[${backend}] identity-rekey-candidates: all 5 changed kinds reported with message/registry counts from any cwd; untracked repo never; writes NOTHING (I7)`, () => {
    const home = mkHome('report-' + backend);
    try {
      const want = new Map();
      KINDS.forEach((kd, i) => {
        const oldKey = legacyRepokey.repoKeyForWorktree(fx.cwds[kd]);
        const s = store.openStore({ home, hash: oldKey, backend, env: ENV });
        for (let j = 0; j <= i; j++) send(s, { from: 'a', to: 'p' + j, type: 'direct', message: kd + j, timestamp: j + 1 });
        s.upsertRegistry({ id: 'w' + i, worktreePath: fx.cwds[kd], sessionId: 's' + i });
        s.close();
        want.set(oldKey, { kind: kd, messages: i + 1, newKey: identity.resolveContext(fx.cwds[kd], { memo: false }).repoKey });
      });
      const untrackedKey = legacyRepokey.repoKeyForWorktree(fx.cwds['main/untracked']);
      fs.mkdirSync(store.storeDirForHash(home, untrackedKey), { recursive: true });
      const root = path.join(home, '.anti-hall');
      const before = snapshot(root);
      for (const cwd of [fx.main, fx.wt, fx.subwt]) {
        const r = devswarm.identityRekeyReport(home, { cwd });
        assert.strictEqual(r.ok, true, JSON.stringify(r.stores.filter((x) => x.error)));
        const got = new Map(r.stores.map((x) => [x.oldKey, x]));
        for (const [oldKey, w] of want) {
          const row = got.get(oldKey);
          assert.ok(row, 'cwd=' + path.basename(cwd) + ' missed ' + w.kind);
          assert.strictEqual(row.newKey, w.newKey, w.kind);
          assert.strictEqual(row.messages, w.messages, w.kind);
          assert.strictEqual(row.registryRows, 1, w.kind);
          assert.strictEqual(row.worktreeExists, true, w.kind);
          assert.strictEqual(row.dir, store.storeDirForHash(home, oldKey));
        }
        assert.ok(!got.has(untrackedKey), 'an untracked nested repo keeps its own key: never reported');
        assert.strictEqual(r.totals.messages, 15);
      }
      const rep = doctorRepair.checkIdentityRekey({ home, cwd: fx.main });
      assert.strictEqual(rep.stores, 5);
      assert.strictEqual(rep.messages, 15);
      assert.strictEqual(rep.lines.length, 5);
      assert.deepStrictEqual(snapshot(root), before, 'the report (and doctor check) must write nothing');
    } finally {
      rm(home);
    }
  });
}

test('identity-rekey-candidates: a deleted worktree reads worktreeExists:false; an unreadable store is reported, never thrown; nothing found -> doctor silent', () => {
  const home = mkHome('report-edge');
  try {
    const subKey = legacyRepokey.repoKeyForWorktree(fx.cwds['wt/libs/sub']);
    const s = store.openStore({ home, hash: subKey, backend: 'journal', env: ENV });
    send(s, { from: 'a', to: 'a', type: 'direct', message: 'm', timestamp: 1 });
    s.upsertRegistry({ id: 'gone1', worktreePath: path.join(fx.root, 'no-such-worktree'), sessionId: 's' });
    s.close();
    const rawKey = legacyRepokey.repoKeyForWorktree(fx.cwds['main/vend/raw']);
    fs.mkdirSync(store.storeDirForHash(home, rawKey), { recursive: true });
    fs.writeFileSync(path.join(store.storeDirForHash(home, rawKey), 'journal'), 'not a directory');
    let r;
    assert.doesNotThrow(() => { r = devswarm.identityRekeyReport(home, { cwd: fx.main }); });
    assert.strictEqual(r.stores.find((x) => x.oldKey === subKey).worktreeExists, false);
    assert.ok(r.stores.find((x) => x.oldKey === rawKey).error, 'unreadable store carries an error');
    assert.strictEqual(r.ok, false);
    const empty = mkHome('report-empty');
    try { assert.strictEqual(doctorRepair.checkIdentityRekey({ home: empty, cwd: fx.main }), null); } finally { rm(empty); }
  } finally {
    rm(home);
  }
});

// ---- F2 path-change guard compares realpaths (spec §3 "F2 guard note") ----
for (const backend of BACKENDS) {
  test(`[${backend}] upsertRegistry F2 guard: a symlinked / submodule spelling of the SAME worktree is not a collision; a different worktree still is`, () => {
    const home = mkHome('f2-' + backend);
    try {
      const s = store.openStore({ home, hash: 'f2test-abcdef', backend, env: ENV });
      try {
        const physicalMain = fs.realpathSync(fx.main);
        const row = (id, wp) => ({ id, worktreePath: wp, sessionId: 's-' + id });
        // symlinked spelling registered first, physical spelling saved after re-key
        assert.notStrictEqual(s.upsertRegistry(row('w1', fx.cwds['mainlink/src'].replace(/\/src$/, ''))), false);
        assert.notStrictEqual(s.upsertRegistry(row('w1', physicalMain)), false, 'same physical worktree must save');
        assert.strictEqual(s.listRegistry().find((r) => r.id === 'w1').worktreePath, physicalMain);
        // registered from inside a submodule, saved at its key-bearing worktree root
        assert.notStrictEqual(s.upsertRegistry(row('w2', fx.cwds['wt/libs/sub'])), false);
        assert.notStrictEqual(s.upsertRegistry(row('w2', fs.realpathSync(fx.wt))), false, 'submodule -> worktree root must save');
        // a genuinely different worktree is still refused
        assert.strictEqual(s.upsertRegistry(row('w2', physicalMain)), false, 'different worktree must stay refused');
        assert.strictEqual(s.listRegistry().find((r) => r.id === 'w2').worktreePath, fs.realpathSync(fx.wt));
      } finally { s.close(); }
    } finally {
      rm(home);
    }
  });
}
