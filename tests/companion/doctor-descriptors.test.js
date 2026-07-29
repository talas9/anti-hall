'use strict';
// doctor-descriptors: REPORT-ONLY integrity scan over the DevSwarm descriptor
// store. Real temp HOME fixtures; nothing outside the fixture is touched.
//
// The calibration tests below (human-readable ids, normal archive twins,
// alternate inbox naming) are REGRESSION GUARDS: each encodes a pattern that
// was measured on the live 76-descriptor store and found to be NORMAL. They
// exist so a future "let's also flag X" change has to fail a test rather than
// quietly turn doctor into a noise machine.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'doctor-descriptors.js',
));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-desc-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function dirOf(home, which) { return path.join(home, '.anti-hall', 'devswarm', which); }

// put(home, which, id, extra, fileName) -> writes <which>/<fileName||id>.json.
function put(home, which, id, extra, fileName) {
  const dir = dirOf(home, which);
  fs.mkdirSync(dir, { recursive: true });
  const body = Object.assign({ id, worktreePath: path.join(home, 'wt', String(id)) }, extra || {});
  fs.writeFileSync(path.join(dir, (fileName || id) + '.json'), JSON.stringify(body));
}

function kinds(findings) { return findings.map((f) => f.kind).sort(); }

const FULL = 'c92b214d-ed3b-4348-b90a-c45c1d4196ac';   // 36 chars, canonical
const TRUNC = 'c92b214d-ed3b-4348-b90a-c45c1d4196';    // 34 chars, last 2 dropped

test('empty store -> nothing scanned, no results', () => {
  const { home, cleanup } = makeHome();
  try {
    const scan = D.scanDescriptors({ home });
    assert.strictEqual(scan.scanned, 0);
    assert.deepStrictEqual(scan.findings, []);
    assert.deepStrictEqual(D.checkResults({ home }), []);
  } finally { cleanup(); }
});

test('clean store -> one PASS line, zero findings', () => {
  const { home, cleanup } = makeHome();
  try {
    put(home, 'workspaces', FULL);
    put(home, 'workspaces', 'primary-2e126d49');
    put(home, 'archived', 'antihall-selftest');
    const scan = D.scanDescriptors({ home });
    assert.strictEqual(scan.scanned, 3);
    assert.deepStrictEqual(scan.findings, [], 'a healthy store produces no findings');
    const res = D.checkResults({ home });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].status, D.PASS);
    assert.match(res[0].message, /3 descriptor\(s\) scanned/);
  } finally { cleanup(); }
});

// ---- the real defect ------------------------------------------------------

test('THE DEFECT: archived id that is a strict prefix of a live id is flagged twice (shape + shadow)', () => {
  const { home, cleanup } = makeHome();
  try {
    put(home, 'workspaces', FULL, { sessionId: '8f1d45f8-508a-4d1a-bced-ffa95f1923bd' });
    put(home, 'archived', TRUNC, { sessionId: FULL });

    const scan = D.scanDescriptors({ home });
    assert.deepStrictEqual(kinds(scan.findings), ['prefix-shadow', 'uuid-malformed'],
      'the truncated descriptor trips BOTH the shape check and the shadow check');

    const shadow = scan.findings.find((f) => f.kind === 'prefix-shadow');
    assert.strictEqual(shadow.status, D.WARN);
    assert.strictEqual(shadow.id, TRUNC);
    assert.strictEqual(shadow.path, path.join(dirOf(home, 'archived'), TRUNC + '.json'),
      'the finding carries the exact on-disk path so a human can go look at it');
    assert.match(shadow.message, /strict PREFIX/);
    assert.match(shadow.message, new RegExp(FULL), 'names the live id it shadows');
    assert.match(shadow.message, /phantom row/);
    assert.match(shadow.message, /REPORT ONLY/, 'states plainly that nothing was touched');

    const shape = scan.findings.find((f) => f.kind === 'uuid-malformed');
    assert.match(shape.message, /34 chars, groups 8-4-4-4-10/);
    assert.match(shape.message, /expected 36 \/ 8-4-4-4-12/);
    assert.match(shape.message, /sessionId .* holds the full-length value/,
      'surfaces the untruncated sessionId as the identifying clue');
  } finally { cleanup(); }
});

test('uuid-malformed fires in workspaces/ too, not just archived/', () => {
  const { home, cleanup } = makeHome();
  try {
    put(home, 'workspaces', TRUNC);
    const scan = D.scanDescriptors({ home });
    assert.deepStrictEqual(kinds(scan.findings), ['uuid-malformed']);
    assert.match(scan.findings[0].message, /workspaces\//);
  } finally { cleanup(); }
});

// ---- calibration / anti-noise regression guards ---------------------------

test('NORMAL ARCHIVE: an archived id that is ALSO live is not a shadow', () => {
  const { home, cleanup } = makeHome();
  try {
    // Archiving leaves the original in workspaces/; on the live store 17 of 20
    // archived ids also exist as active. None of those may be flagged.
    put(home, 'workspaces', FULL);
    put(home, 'archived', FULL);
    assert.deepStrictEqual(D.scanDescriptors({ home }).findings, []);
  } finally { cleanup(); }
});

test('NORMAL: v0.67.0 human-readable ids are never flagged as malformed uuids', () => {
  const { home, cleanup } = makeHome();
  try {
    for (const id of [
      'fix-analytics-coverage-gaps-a55f20ef',
      'primary-2e126d49',
      'antihall-selftest',
      'fl-skyflutter-observability-ga4-event-registry-inst',
      'x-make-the-skyfb-deploy-pipeline-honest-about-drif-a55f20ef',
    ]) put(home, 'workspaces', id);
    assert.deepStrictEqual(D.scanDescriptors({ home }).findings, [],
      'human-readable ids contain non-hex letters and must never trip the uuid shape check');
  } finally { cleanup(); }
});

test('NORMAL: a human-readable id that prefixes another live id is NOT a shadow (both live)', () => {
  const { home, cleanup } = makeHome();
  try {
    // Real pair from the live store, both ACTIVE — the shadow check is
    // archived-only by design, so this must stay silent.
    put(home, 'workspaces', 'fl-skyflutter-observability-ga4-event-registry-inst');
    put(home, 'workspaces', 'fl-skyflutter-observability-ga4-event-registry-inst-a55f20ef');
    assert.deepStrictEqual(D.scanDescriptors({ home }).findings, []);
  } finally { cleanup(); }
});

test('NORMAL: alternate inbox/cursor naming is NOT flagged (33/76 of the live store uses it)', () => {
  const { home, cleanup } = makeHome();
  try {
    put(home, 'workspaces', FULL, {
      inboxPath: path.join(home, 'wt', 'inbox.ndjson'),
      cursorPath: path.join(home, 'wt', 'inbox.cursor'),
    });
    assert.deepStrictEqual(D.scanDescriptors({ home }).findings, [],
      'per-worktree inbox naming is a second valid convention, not corruption');
  } finally { cleanup(); }
});

test('NORMAL: two live descriptors sharing a worktreePath are NOT flagged (v0.67.0 migration residue)', () => {
  const { home, cleanup } = makeHome();
  try {
    const wt = path.join(home, 'wt', 'shared');
    put(home, 'workspaces', '80417e76-9312-48c6-b500-6ed4684225e3', { worktreePath: wt });
    put(home, 'workspaces', 'fix-skyflutter-live-crashes-a55f20ef', { worktreePath: wt });
    assert.deepStrictEqual(D.scanDescriptors({ home }).findings, []);
  } finally { cleanup(); }
});

// ---- other malformed shapes ----------------------------------------------

test('filename/id mismatch is reported', () => {
  const { home, cleanup } = makeHome();
  try {
    put(home, 'workspaces', FULL, null, 'some-other-name');
    const scan = D.scanDescriptors({ home });
    assert.deepStrictEqual(kinds(scan.findings), ['filename-mismatch']);
    assert.match(scan.findings[0].message, /does not match its filename/);
  } finally { cleanup(); }
});

test('torn JSON and a missing id are reported, never thrown', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = dirOf(home, 'workspaces');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'torn.json'), '{"id": "x"');
    fs.writeFileSync(path.join(dir, 'noid.json'), JSON.stringify({ worktreePath: '/tmp/x' }));
    const scan = D.scanDescriptors({ home });
    assert.deepStrictEqual(kinds(scan.findings), ['id-missing', 'unreadable']);
    for (const f of scan.findings) assert.strictEqual(f.status, D.WARN);
  } finally { cleanup(); }
});

test('non-.json files in the descriptor dirs are ignored', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = dirOf(home, 'archived');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
    fs.writeFileSync(path.join(dir, 'x.json.tmp'), 'garbage');
    const scan = D.scanDescriptors({ home });
    assert.strictEqual(scan.scanned, 0);
    assert.deepStrictEqual(scan.findings, []);
  } finally { cleanup(); }
});

// ---- the safety contract --------------------------------------------------

function snapshot(root) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { out.push('D ' + p); walk(p); }
      else out.push('F ' + p + ' ' + st.size + ' ' + st.mtimeMs + ' ' + fs.readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out.join('\n');
}

test('SAFETY: the scan mutates nothing — a flagged store is byte-identical afterwards', () => {
  const { home, cleanup } = makeHome();
  try {
    put(home, 'workspaces', FULL, { sessionId: '8f1d45f8-508a-4d1a-bced-ffa95f1923bd' });
    put(home, 'archived', TRUNC, { sessionId: FULL });
    put(home, 'archived', 'antihall-selftest');
    const root = path.join(home, '.anti-hall', 'devswarm');

    const before = snapshot(root);
    const scan = D.scanDescriptors({ home });
    D.checkResults({ home });
    const after = snapshot(root);

    assert.ok(scan.findings.length > 0, 'precondition: this fixture really does trip the check');
    assert.strictEqual(after, before,
      'REPORT-ONLY contract: no descriptor may be deleted, moved, renamed or rewritten');
  } finally { cleanup(); }
});

test('SAFETY: the module exposes no repair/delete surface', () => {
  const exported = Object.keys(D).sort();
  assert.deepStrictEqual(exported,
    ['PASS', 'UUID_CANONICAL', 'UUID_SHAPED', 'WARN', 'checkResults', 'scanDescriptors'],
    'adding a fix/repair/prune export here is out of scope by design');
  const src = fs.readFileSync(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'doctor-descriptors.js',
  ), 'utf8');
  for (const forbidden of ['unlinkSync', 'rmSync', 'renameSync', 'writeFileSync', 'rmdirSync', 'copyFileSync']) {
    assert.ok(!src.includes(forbidden), 'doctor-descriptors.js must not call ' + forbidden);
  }
});

test('checkResults never throws when the store is unreadable (fail-open)', () => {
  const res = D.checkResults({ home: '/nonexistent/antihall/fixture' });
  assert.deepStrictEqual(res, []);
});
