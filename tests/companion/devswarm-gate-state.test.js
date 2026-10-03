'use strict';
// devswarm-gate-state — shared path/shape helpers for
// devswarm-parent-gate.js's per-session loop-state files, and the
// stated-intent additive-shape forward migration (persisted-shape-migration
// discipline: an additive persisted-shape change needs a forward migration in
// BOTH update.js and doctor-repair.js, idempotent, fail-open, no-delete).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeHome } = require('../helpers/fixtures.js');

const M = require('../../plugins/anti-hall/companion/lib/devswarm-gate-state.js');
const migrateState = require('../../plugins/anti-hall/scripts/migrate-state.js');

test('stateFileFor: sanitizes an unsafe session id to a safe filename', () => {
  const home = '/home/x';
  const p = M.stateFileFor('../../etc/passwd', home);
  assert.equal(p, path.join(home, '.anti-hall', 'devswarm', 'parent-gate', '.._.._etc_passwd.json'));
});

test('isGateStateFilename: distinguishes session-keyed state files from *-replies.json', () => {
  assert.equal(M.isGateStateFilename('sess-1.json'), true);
  assert.equal(M.isGateStateFilename('nosession.json'), true);
  assert.equal(M.isGateStateFilename('repo-key-replies.json'), false);
  assert.equal(M.isGateStateFilename('notes.txt'), false);
});

test('migrateGateIntentsShape: adds intents/intentAcks to a pre-feature file, preserving every other field', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.stateFileFor('sess-1', home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sig: 'abc', blocks: 2, escalated: false, qSig: '', qBlocks: 0, qEscalated: false }));

    const report = M.migrateGateIntentsShape(home);
    assert.equal(report.scanned, 1);
    assert.equal(report.migrated, 1);
    assert.equal(report.errors, 0);

    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(data.intents, {});
    assert.equal(data.intentAcks, 0);
    assert.equal(data.sig, 'abc', 'pre-existing fields preserved');
    assert.equal(data.blocks, 2, 'pre-existing fields preserved');
  } finally { cleanup(); }
});

test('migrateGateIntentsShape: IDEMPOTENT — a second run changes nothing (file already carries both keys)', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.stateFileFor('sess-1', home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sig: 'abc', blocks: 2, escalated: false }));

    const first = M.migrateGateIntentsShape(home);
    assert.equal(first.migrated, 1);
    const afterFirst = fs.readFileSync(p, 'utf8');

    const second = M.migrateGateIntentsShape(home);
    assert.equal(second.migrated, 0, 'nothing left to migrate');
    assert.equal(second.alreadyCurrent, 1, 'the already-normalized file is detected and skipped');
    assert.equal(fs.readFileSync(p, 'utf8'), afterFirst, 're-run is byte-identical (no churn)');
  } finally { cleanup(); }
});

test('migrateGateIntentsShape: ONLY touches gate-state files, never *-replies.json in the same dir', () => {
  const { home, cleanup } = makeHome();
  try {
    const gateP = M.stateFileFor('sess-1', home);
    fs.mkdirSync(path.dirname(gateP), { recursive: true });
    fs.writeFileSync(gateP, JSON.stringify({ sig: 'abc' }));
    const repliesP = path.join(path.dirname(gateP), 'some-repo-key-replies.json');
    fs.writeFileSync(repliesP, JSON.stringify({ 'child-a': { lastReplyTs: 1 } }));

    const report = M.migrateGateIntentsShape(home);
    assert.equal(report.scanned, 1, 'must scan only the ONE gate-state file, not the reply-state file');
    const repliesRaw = fs.readFileSync(repliesP, 'utf8');
    assert.equal(repliesRaw, JSON.stringify({ 'child-a': { lastReplyTs: 1 } }), 'reply-state file must be byte-identical, never touched');
  } finally { cleanup(); }
});

test('migrateGateIntentsShape: dryRun counts pending WITHOUT writing anything', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.stateFileFor('sess-1', home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const raw = JSON.stringify({ sig: 'abc' });
    fs.writeFileSync(p, raw);

    const report = M.migrateGateIntentsShape(home, { dryRun: true });
    assert.equal(report.pending, 1);
    assert.equal(fs.readFileSync(p, 'utf8'), raw, 'dryRun must never write');
  } finally { cleanup(); }
});

test('migrateGateIntentsShape: FAIL-OPEN — a corrupt state file is left untouched, counted as an error, never deleted', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.stateFileFor('sess-1', home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ not valid json,,, ]]]');

    const report = M.migrateGateIntentsShape(home);
    assert.equal(report.errors, 1);
    assert.equal(report.migrated, 0);
    assert.equal(fs.existsSync(p), true, 'must never delete a corrupt file');
    assert.equal(fs.readFileSync(p, 'utf8'), '{ not valid json,,, ]]]', 'must never overwrite a corrupt file with a guess');
  } finally { cleanup(); }
});

test('migrateGateIntentsShape: missing parent-gate dir is a safe zeroed no-op (fail-open)', () => {
  const { home, cleanup } = makeHome();
  try {
    const report = M.migrateGateIntentsShape(home);
    assert.deepEqual(report, { scanned: 0, migrated: 0, alreadyCurrent: 0, pending: 0, errors: 0 });
  } finally { cleanup(); }
});

test('migrate-state.js migrateGateIntents wrapper delegates to the gate-state module', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.stateFileFor('sess-1', home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sig: 'abc' }));

    const dry = migrateState.migrateGateIntents({ dryRun: true, home });
    assert.equal(dry.pending, 1);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).intents, undefined, 'dryRun must not write');

    const applied = migrateState.migrateGateIntents({ home });
    assert.equal(applied.migrated, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).intents, {});
  } finally { cleanup(); }
});
