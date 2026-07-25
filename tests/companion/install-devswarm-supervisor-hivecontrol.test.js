'use strict';
// install-devswarm-supervisor-hivecontrol.test.js — supervisor half of the v0.66
// ENOENT-storm fix.
//
// VERIFIED FIELD DEFECT (live this session): v0.66 baked a resolved hivecontrol
// PATH + ANTIHALL_DEVSWARM_HIVECONTROL into the PER-PROJECT devswarm-ingest units
// (install-devswarm-ingest.js's buildPlist/buildService/buildCronLine), but the
// SINGLETON com.anti-hall.devswarm-supervisor unit (this file's target,
// install-devswarm-supervisor.js) was never updated — it still shipped with NO
// EnvironmentVariables key. Its live process therefore ran with PATH=/usr/bin:
// /bin:/usr/sbin:/sbin and its short-lived `devswarm-cli inbox-pull` subprocesses
// (devswarm-supervisor.js, out of this fix's edit boundary) kept failing
// `spawnSync hivecontrol ENOENT` long after the ingest-side fix landed.
//
// This file locks down that the supervisor's plist/service/cron builders now
// bake the SAME env (via the SAME resolveHivecontrolPath/unitEnvFor helpers
// install-devswarm-ingest.js already proved out — never a re-derived copy):
// present when the binary resolves, cleanly omitted (never a crash, never an
// empty dict) when it does not, and byte-stable across repeated regeneration
// (so doctor --repair / update reconcile can never silently revert it, exactly
// the failure mode that made a hand-patched plist worthless before).
//
// HERMETIC: no real launchctl/systemctl/crontab is ever touched, and no real
// `~/Library/LaunchAgents` is written — every builder call passes its own
// explicit args, and the one resolver test injects io.lookupRun so no real shell
// is spawned either.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-supervisor.js');
const m = require(MOD);

test('resolveHivecontrolPath/unitEnvFor are the SAME functions install-devswarm-ingest.js exports (no re-derived copy)', () => {
  const ingest = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js'));
  assert.strictEqual(m.resolveHivecontrolPath, ingest.resolveHivecontrolPath, 'must be the identical function reference, not a duplicate');
  assert.strictEqual(m.unitEnvFor, ingest.unitEnvFor, 'must be the identical function reference, not a duplicate');
});

test('buildPlist: WITHOUT the fix this would fail — bakes EnvironmentVariables and is byte-stable across regeneration', () => {
  const args = { label: 'com.anti-hall.devswarm-supervisor', exec: '/usr/bin/node', script: '/s/devswarm-supervisor.js', log: '/l', interval: 90, hivecontrol: '/opt/dv/bin/hivecontrol' };
  const a = m.buildPlist(args);
  const b = m.buildPlist(args);
  assert.equal(a, b, 'two consecutive builds are byte-identical — a reconcile cannot drop the env');
  assert.match(a, /<key>EnvironmentVariables<\/key>/, 'FAILS pre-fix: the old builder never emitted this key at all');
  assert.match(a, /<key>ANTIHALL_DEVSWARM_HIVECONTROL<\/key>\s*<string>\/opt\/dv\/bin\/hivecontrol<\/string>/);
  assert.match(a, /<key>PATH<\/key>\s*<string>\/opt\/dv\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.equal((a.match(/<dict>/g) || []).length, (a.match(/<\/dict>/g) || []).length, 'plist stays well-formed');
  assert.equal((a.match(/<string>/g) || []).length, (a.match(/<\/string>/g) || []).length);
});

test('buildPlist: unresolved binary omits the key entirely — never crashes, never an empty dict (fail-open)', () => {
  const none = m.buildPlist({ label: 'com.x', exec: '/n', script: '/s', log: '/l', interval: 90 });
  assert.ok(!/EnvironmentVariables/.test(none), 'no resolution -> no environment key');
  assert.equal((none.match(/<dict>/g) || []).length, (none.match(/<\/dict>/g) || []).length);
});

test('buildPlist: a hostile (quote-carrying) hivecontrol path is refused, not emitted', () => {
  const nasty = m.buildPlist({ label: 'com.x', exec: '/n', script: '/s', log: '/l', interval: 90, hivecontrol: '/opt/"evil"/hivecontrol' });
  assert.ok(!/EnvironmentVariables/.test(nasty), 'a quote-carrying path is never baked into a unit');
});

test('buildService: WITHOUT the fix this would fail — bakes Environment= lines ahead of ExecStart, byte-stable', () => {
  const args = { exec: '/usr/bin/node', script: '/s/devswarm-supervisor.js', hivecontrol: '/opt/dv/bin/hivecontrol' };
  const a = m.buildService(args);
  assert.equal(a, m.buildService(args), 'byte-stable across regeneration');
  assert.match(a, /^Environment="PATH=\/opt\/dv\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"$/m, 'FAILS pre-fix: no Environment= line existed at all');
  assert.match(a, /^Environment="ANTIHALL_DEVSWARM_HIVECONTROL=\/opt\/dv\/bin\/hivecontrol"$/m);
  assert.ok(a.indexOf('Environment=') < a.indexOf('ExecStart='), 'environment is declared before ExecStart');
  assert.ok(a.includes('ExecStart="/usr/bin/node" "/s/devswarm-supervisor.js"'), 'ExecStart itself is unchanged');
});

test('buildService: unresolved binary omits Environment= entirely (fail-open, still installs)', () => {
  const none = m.buildService({ exec: '/n', script: '/s' });
  assert.ok(!/Environment=/.test(none));
  assert.ok(none.includes('Type=oneshot'), 'the rest of the unit is unaffected');
});

test('buildCronLine: WITHOUT the fix this would fail — bakes an env prefix ahead of the command, byte-stable', () => {
  const args = { exec: '/usr/bin/node', script: '/s/devswarm-supervisor.js', hivecontrol: '/opt/dv/bin/hivecontrol' };
  const a = m.buildCronLine(args);
  assert.equal(a, m.buildCronLine(args), 'byte-stable across regeneration');
  assert.match(a, /PATH="\/opt\/dv\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/, 'FAILS pre-fix: no env prefix existed at all');
  assert.match(a, /ANTIHALL_DEVSWARM_HIVECONTROL="\/opt\/dv\/bin\/hivecontrol"/);
  assert.ok(a.includes('"/usr/bin/node" "/s/devswarm-supervisor.js" >/dev/null 2>&1'), 'the underlying cron command is unchanged');
});

test('buildCronLine: unresolved binary omits the env prefix entirely (fail-open)', () => {
  const line = m.buildCronLine({ exec: '/usr/bin/node', script: '/s/devswarm-supervisor.js' });
  assert.equal(line, '* * * * * "/usr/bin/node" "/s/devswarm-supervisor.js" >/dev/null 2>&1', 'identical to the pre-v0.66 shape when nothing resolves');
});

test('resolveHivecontrolPath: explicit env override short-circuits the shell probe (hermetic — no real shell spawned)', () => {
  const bin = '/opt/devswarm/cli/hivecontrol';
  const got = m.resolveHivecontrolPath({
    platform: 'darwin', env: { ANTIHALL_DEVSWARM_HIVECONTROL: bin },
    io: {
      lookupRun: () => { throw new Error('must not be consulted — env var should short-circuit'); },
      fs: { statSync: () => ({ isFile: () => true }), accessSync: () => {} },
    },
  });
  assert.equal(got, bin);
});
