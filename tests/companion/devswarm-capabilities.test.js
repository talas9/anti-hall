'use strict';
// v0.108.0 — companion/lib/devswarm-capabilities.js: every DevSwarm surface is
// gated by minVersion AND runtime detection; a missing surface sleeps.
//   - 2.5.2 (REAL captured help): archive/delete dormant, existing verbs ok
//   - 2.5.3 (UNVERIFIED fixture from release notes): archive/delete detected
//   - unknown version: detection alone decides
//   - missing app-DB column: dormant
//   - hivecontrol absent: everything dormant and silent (no doctor line)
//   - gatedRun refuses a dormant verb without spawning it; passes through when absent

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const caps = require(path.join(ROOT, 'companion', 'lib', 'devswarm-capabilities.js'));
const doctor = require(path.join(ROOT, 'companion', 'lib', 'doctor-devswarm.js'));
const { fakeHivecontrol, readCalls } = require('../helpers/fake-hivecontrol.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'devswarm-capabilities');
const HELP_252 = path.join(FIX, 'hivecontrol-2.5.2-workspace-help.txt');
const HELP_253 = path.join(FIX, 'hivecontrol-2.5.3-workspace-help.UNVERIFIED.txt');
const ARCHIVE_253 = path.join(FIX, 'hivecontrol-2.5.3-archive-help.UNVERIFIED.txt');
const DELETE_253 = path.join(FIX, 'hivecontrol-2.5.3-delete-help.UNVERIFIED.txt');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

function setup(fakeOpts) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-caps-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const fake = fakeOpts ? fakeHivecontrol(path.join(base, 'bin'), fakeOpts) : null;
  const env = { HOME: home, PATH: fake ? fake.dir : path.join(base, 'empty-bin'), ANTIHALL_DEVSWARM_APP_DB: 'off' };
  caps.resetCache();
  return { base, home, env, fake, opts: { env, home, knownLocations: [], platform: 'linux' } };
}

test('parseCommands reads the REAL 2.5.2 help: existing verbs present, archive/delete absent', () => {
  const m = caps.parseCommands(fs.readFileSync(HELP_252, 'utf8'));
  for (const v of ['list', 'info', 'create', 'update-title', 'check-merge', 'merge-from-source', 'merge-into-source',
    'message-child', 'message-parent', 'read-messages', 'message-count', 'monitor']) {
    assert.ok(m.has(v), 'missing verb ' + v);
  }
  assert.strictEqual(m.has('archive'), false);
  assert.strictEqual(m.has('delete'), false);
  assert.strictEqual(m.get('create').usage, '[options] <branch>');
});

test('2.5.2 fake: archive/delete dormant with a doctor line; existing verbs ok', () => {
  const s = setup({ version: '2.5.2', workspaceHelp: HELP_252 });
  const a = caps.can('workspace.archive', s.opts);
  assert.strictEqual(a.ok, false);
  assert.match(a.reason, /requires DevSwarm >= 2\.5\.3 \(have 2\.5\.2\)/);
  assert.strictEqual(caps.requireCap('workspace.delete', s.opts).dormant, true);
  assert.strictEqual(caps.can('workspace.list', s.opts).ok, true);
  assert.strictEqual(caps.can('workspace.monitor', s.opts).ok, true);
  const lines = caps.dormantLines(s.home);
  assert.ok(lines.some((l) => /workspace\.archive.*needs DevSwarm >= 2\.5\.3, you have 2\.5\.2/.test(l)), lines.join('\n'));
  const d = doctor.capabilitiesCheck({ home: s.home });
  assert.strictEqual(d.status, doctor.PASS);
  assert.match(d.message, /dormant feature/);
  // Only read-only probes were spawned (--version, --help); never archive/delete.
  const argvs = readCalls(s.fake.callsFile).map((c) => c.argv.join(' '));
  assert.ok(argvs.every((x) => x === '--version' || /--help$/.test(x)), argvs.join('|'));
  // Cached per binary build: a second can() spawns nothing new.
  const before = readCalls(s.fake.callsFile).length;
  caps.resetCache();
  caps.can('workspace.archive', s.opts);
  assert.strictEqual(readCalls(s.fake.callsFile).length, before);
});

test('2.5.3 fake (UNVERIFIED fixture): archive/delete detected with usage + flags', () => {
  const s = setup({ version: '2.5.3', workspaceHelp: HELP_253, verbHelp: { archive: ARCHIVE_253, delete: DELETE_253 } });
  const a = caps.can('workspace.archive', s.opts);
  assert.strictEqual(a.ok, true, a.reason);
  assert.deepStrictEqual(a.detail.args, [{ name: 'idOrBranch', required: false }]);
  const d = caps.can('workspace.delete', s.opts);
  assert.strictEqual(d.ok, true);
  assert.ok(d.detail.flags.includes('--yes'));
  assert.deepStrictEqual(caps.dormantLines(s.home), []);
});

test('version floor AND detection: 2.5.3 help but version 2.5.2 -> still dormant', () => {
  const s = setup({ version: '2.5.2', workspaceHelp: HELP_253, verbHelp: { archive: ARCHIVE_253 } });
  assert.strictEqual(caps.can('workspace.archive', s.opts).ok, false);
});

test('unknown version: detection alone decides (sentry fallback absent)', () => {
  const s = setup({ version: null, workspaceHelp: HELP_253, verbHelp: { archive: ARCHIVE_253 } });
  const a = caps.can('workspace.archive', s.opts);
  assert.strictEqual(a.version, null);
  assert.strictEqual(a.ok, true);
  const s2 = setup({ version: null, workspaceHelp: HELP_252 });
  assert.strictEqual(caps.can('workspace.archive', s2.opts).ok, false);
});

test('version falls back to the app sentry session.json release', () => {
  const s = setup({ version: null, workspaceHelp: HELP_252 });
  const dir = path.join(s.home, 'Library', 'Application Support', 'DevSwarm', 'sentry');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ release: 'DevSwarm@2.5.2' }));
  assert.strictEqual(caps.can('workspace.archive', s.opts).version, '2.5.2');
});

test('hivecontrol absent: everything dormant and SILENT; gatedRun passes through', () => {
  const s = setup(null);
  const a = caps.can('workspace.archive', s.opts);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.reason, 'hivecontrol-absent');
  assert.strictEqual(a.silent, true);
  assert.strictEqual(caps.can('workspace.list', s.opts).ok, false);
  assert.deepStrictEqual(caps.dormantLines(s.home), []);
  let called = 0;
  const run = caps.gatedRun(() => { called++; return { ok: false, raw: '', error: 'spawnSync hivecontrol ENOENT' }; }, { knownLocations: [] });
  const r = run({ args: ['workspace', 'list', 'all'], env: s.env });
  assert.strictEqual(called, 1, 'absent binary must pass through to the existing error path');
  assert.match(r.error, /ENOENT/);
});

test('gatedRun refuses a dormant verb WITHOUT spawning it; allows a present verb', () => {
  const s = setup({ version: '2.5.2', workspaceHelp: HELP_252 });
  const seen = [];
  const run = caps.gatedRun((spec) => { seen.push(spec.args.join(' ')); return { ok: true, raw: '[]' }; });
  const r = run({ args: ['workspace', 'archive', 'x'], env: s.env });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.dormant, true);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(run({ args: ['workspace', 'list', 'all'], env: s.env }).ok, true);
  assert.deepStrictEqual(seen, ['workspace list all']);
  assert.strictEqual(caps.capabilityForArgs(['health']), null);
});

test('app-DB: present column ok, missing column / missing table dormant', { skip: sqlite ? false : 'node:sqlite unavailable' }, () => {
  const s = setup(null);
  const dbFile = path.join(s.base, 'devswarm.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, isActive INTEGER, isHidden INTEGER)');
  db.close();
  const opts = Object.assign({}, s.opts, { env: Object.assign({}, s.env, { ANTIHALL_DEVSWARM_APP_DB: dbFile }) });
  caps.resetCache();
  assert.strictEqual(caps.can('appdb.builders.isActive', opts).ok, true);
  const miss = caps.can('appdb.builders.lastSelectedAt', opts);
  assert.strictEqual(miss.ok, false);
  assert.match(miss.reason, /builders\.lastSelectedAt missing/);
  assert.strictEqual(caps.can('appdb.pull_requests', opts).ok, false);
  assert.strictEqual(caps.can('appdb.builders', Object.assign({}, s.opts)).ok, false, 'app DB off -> dormant');
  assert.strictEqual(caps.can('no.such.cap', opts).reason, 'unknown-capability');
});

test('registry covers every hivecontrol verb anti-hall calls plus archive/delete', () => {
  const names = new Set(caps.CAPABILITIES.map((c) => c.name));
  for (const v of ['list', 'create', 'update-title', 'check-merge', 'merge-from-source', 'merge-into-source',
    'message-child', 'message-parent', 'read-messages', 'message-count', 'monitor', 'archive', 'delete']) {
    assert.ok(names.has('workspace.' + v), v);
  }
  for (const c of ['appdb.builders.isActive', 'appdb.builders.isHidden', 'appdb.builders.label', 'appdb.builders.rank',
    'appdb.builders.lastSelectedAt', 'appdb.builder_terminals.ai_session_config', 'appdb.builder_terminals.initialPrompt',
    'appdb.builder_terminals.panelStatus', 'appdb.pull_requests', 'appdb.workspace_messages']) {
    assert.ok(names.has(c), c);
  }
  assert.deepStrictEqual(caps.SIDE_EFFECTING_VERBS, ['check-merge']);
});
