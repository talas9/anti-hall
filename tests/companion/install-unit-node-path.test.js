'use strict';
// install-unit-node-path — the scheduler unit must carry the node bin dir on PATH.
//
// ROOT CAUSE (v0.86). Both companion installers bake `process.execPath` — the
// ABSOLUTE node that ran the installer, commonly a version-manager path such as
// ~/.nvm/versions/node/vX.Y.Z/bin/node — into the unit's ProgramArguments /
// ExecStart, while the PATH they emitted was only
//   <hivecontrol bin dir>:/usr/bin:/bin:/usr/sbin:/sbin
// The daemon therefore STARTS fine (absolute argv[0] needs no PATH), which is
// exactly why this hid for so long: nothing about the daemon looked broken. But
// `hivecontrol` is a SCRIPT whose shebang re-resolves `node` THROUGH PATH, so
// every grandchild call died with `env: node: No such file or directory`
// (exit 127) — measured on this machine as 23,928 such failures across 1,757
// supervisor sweeps spanning three distinct repoKeys, with healed:0 on every
// single one. Reconciliation could never heal anything, for any scope.
//
// THE FIX: unitEnvFor() — the SINGLE chokepoint every emitter derives its unit
// environment from — prepends path.dirname(exec). All SIX emitters pass the
// same `exec` they bake, so the PATH can never disagree with the interpreter
// the unit actually launches.
//
// ---------------------------------------------------------------------------
// MUTATION LIST (each mutation was applied to the shipped source and this file
// re-run; the named test FAILED for each, so none of these assertions is
// vacuous). Kept HERE, in the test, so the evidence is discoverable — not
// stranded in a transcript.
//
//  M1  unitEnvFor: drop the `push(nodeDir)` line entirely (restore the pre-fix
//      PATH)                          -> KILLED by every emitter test below
//                                         + 'unitEnvFor prepends the node bin dir'
//  M2  unitEnvFor: `if (!bin && !nodeDir) return null` -> `if (!bin) return null`
//      (PATH silently dropped whenever hivecontrol is unresolved)
//                                      -> KILLED by 'unresolved hivecontrol still
//                                         yields a node-resolvable PATH'
//  M3  unitEnvFor: append nodeDir AFTER the minimal PATH instead of before
//                                      -> KILLED by 'the node bin dir is PREPENDED'
//  M4  unitEnvFor: drop the dedupe (`parts.indexOf(p) === -1`)
//                                      -> KILLED by 'no duplicate PATH entries'
//  M5  buildPlist (ingest): revert to `unitEnvFor(hivecontrol)` (no exec passed)
//                                      -> KILLED by 'ingest buildPlist'
//  M6  buildService (ingest): revert to `unitEnvFor(hivecontrol)`
//                                      -> KILLED by 'ingest buildService'
//  M7  buildCronLine (ingest): revert to `unitEnvFor(hivecontrol)`
//                                      -> KILLED by 'ingest buildCronLine'
//  M8  supervisor buildPlist: revert to `unitEnvFor(hivecontrol)`
//                                      -> KILLED by 'supervisor buildPlist'
//  M9  supervisor buildService: revert to `unitEnvFor(hivecontrol)`
//                                      -> KILLED by 'supervisor buildService'
//  M10 supervisor buildCronLine: revert to `unitEnvFor(hivecontrol)`
//                                      -> KILLED by 'supervisor buildCronLine'
//  M11 unitEnvFor: keep emitting the hivecontrol pin even when the path is not
//      emittable (drop the `pathIsEmittable` half of `usable`)
//                                      -> KILLED by 'a hostile hivecontrol path
//                                         is still never emitted'
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ingest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const supervisor = require('../../plugins/anti-hall/companion/install-devswarm-supervisor.js');

// A node path that is NOT on any scheduler's default PATH — the shape a
// version-manager install actually produces.
const NVM_NODE = '/Users/x/.nvm/versions/node/v24.14.0/bin/node';
const NVM_DIR = '/Users/x/.nvm/versions/node/v24.14.0/bin';
const HC = '/Applications/DevSwarm.app/Contents/Resources/cli/hivecontrol';
const HC_DIR = '/Applications/DevSwarm.app/Contents/Resources/cli';
const MIN = ingest.MINIMAL_UNIT_PATH;

test('unitEnvFor prepends the node bin dir so a shebang script can resolve `node`', () => {
  const env = ingest.unitEnvFor(HC, NVM_NODE);
  assert.strictEqual(env.PATH, HC_DIR + ':' + NVM_DIR + ':' + MIN,
    'PATH must carry BOTH the hivecontrol dir and the dir of the baked node');
  assert.ok(env.PATH.split(':').includes(NVM_DIR),
    'FAILS pre-fix: the node bin dir was never on the emitted PATH, so every ' +
    '`hivecontrol` shebang re-resolution of `node` died exit 127');
  assert.strictEqual(env.ANTIHALL_DEVSWARM_HIVECONTROL, HC, 'the absolute binary is still pinned');
});

test('the node bin dir is PREPENDED to (never appended after) the scheduler default PATH', () => {
  const parts = ingest.unitEnvFor(HC, NVM_NODE).PATH.split(':');
  assert.ok(parts.indexOf(NVM_DIR) < parts.indexOf('/usr/bin'),
    'a system node on /usr/bin must never shadow the interpreter the unit actually launches');
});

test('unresolved hivecontrol still yields a node-resolvable PATH (no env at all was the pre-fix shape)', () => {
  const env = ingest.unitEnvFor(null, NVM_NODE);
  assert.ok(env, 'an unresolvable hivecontrol must not also cost the daemon its node PATH');
  assert.strictEqual(env.PATH, NVM_DIR + ':' + MIN);
  assert.ok(!(ingest.HIVECONTROL_ENV_VAR in env), 'nothing is pinned when nothing was resolved');
});

test('no duplicate PATH entries when the node dir already appears in the merged PATH', () => {
  const env = ingest.unitEnvFor('/usr/bin/hivecontrol', '/usr/bin/node');
  assert.strictEqual(env.PATH, MIN, 'both dirs are /usr/bin — the merge must not repeat it');
  const p = ingest.unitEnvFor(HC, NVM_NODE).PATH.split(':');
  assert.strictEqual(new Set(p).size, p.length, 'no entry appears twice');
});

test('unitEnvFor stays null only when NEITHER an absolute hivecontrol NOR an absolute exec is given', () => {
  assert.strictEqual(ingest.unitEnvFor(null, null), null);
  assert.strictEqual(ingest.unitEnvFor('hivecontrol', 'node'), null, 'relative paths are never baked');
});

test('a hostile hivecontrol path is still never emitted, but PATH survives', () => {
  const env = ingest.unitEnvFor('/opt/"evil"/hivecontrol', NVM_NODE);
  assert.ok(!(ingest.HIVECONTROL_ENV_VAR in env), 'a quote-carrying path is refused');
  assert.ok(!/evil/.test(env.PATH), 'and never leaks into PATH either');
  assert.strictEqual(env.PATH, NVM_DIR + ':' + MIN);
});

test('a hostile exec path is refused too (PATH falls back to the hivecontrol-only merge)', () => {
  const env = ingest.unitEnvFor(HC, '/opt/"evil"/bin/node');
  assert.strictEqual(env.PATH, HC_DIR + ':' + MIN);
});

// ---------------------------------------------------------------------------
// ALL SIX EMITTERS. install-devswarm-supervisor.js imports unitEnvFor from the
// ingest installer, so one chokepoint covers both files — these assertions are
// what prove no emitter was missed.
// ---------------------------------------------------------------------------
const EMITTERS = [
  ['ingest buildPlist', (a) => ingest.buildPlist(Object.assign({ label: 'com.x', script: '/s', log: '/l', workdir: '/w' }, a))],
  ['ingest buildService', (a) => ingest.buildService(Object.assign({ script: '/s', workdir: '/w', log: '/l' }, a))],
  ['ingest buildCronLine', (a) => ingest.buildCronLine(Object.assign({ script: '/s', workdir: '/w', log: '/l' }, a))],
  ['supervisor buildPlist', (a) => supervisor.buildPlist(Object.assign({ label: 'com.y', script: '/s', log: '/l' }, a))],
  ['supervisor buildService', (a) => supervisor.buildService(Object.assign({ script: '/s' }, a))],
  ['supervisor buildCronLine', (a) => supervisor.buildCronLine(Object.assign({ script: '/s' }, a))],
];

for (const [name, build] of EMITTERS) {
  test(`${name} bakes the node bin dir into the unit PATH`, () => {
    const out = build({ exec: NVM_NODE, hivecontrol: HC });
    assert.ok(out.includes(HC_DIR + ':' + NVM_DIR + ':' + MIN),
      `FAILS pre-fix: ${name} emitted a PATH with no node bin dir, so every hivecontrol ` +
      `grandchild spawn from this unit failed \`env: node: No such file or directory\`.\n` +
      `Emitted unit was:\n${out}`);
    assert.ok(out.includes(NVM_NODE), 'the same absolute node is still what the unit launches');
  });

  test(`${name} is byte-stable across regeneration (a reconcile cannot drop the env)`, () => {
    const a = build({ exec: NVM_NODE, hivecontrol: HC });
    assert.strictEqual(a, build({ exec: NVM_NODE, hivecontrol: HC }));
  });

  test(`${name} still bakes a node PATH when hivecontrol is unresolved`, () => {
    const out = build({ exec: NVM_NODE });
    assert.ok(out.includes(NVM_DIR + ':' + MIN),
      `${name} must not leave a PATH-less unit behind just because the CLI was not found`);
    assert.ok(!out.includes(ingest.HIVECONTROL_ENV_VAR), 'nothing is pinned when nothing was resolved');
  });
}

test('the cron readback still parses once the node dir is in the baked env prefix', () => {
  // parseCronCommand strips the `VAR='value' ` assignment prefix before
  // tokenizing; a longer PATH must not fool it into reading an env value as the
  // script path (doctor's install-shape classifier depends on this readback).
  const line = ingest.buildCronLine({ exec: NVM_NODE, script: '/s/ingest.js', workdir: '/w', log: '/l', hivecontrol: HC });
  assert.deepStrictEqual(ingest.parseCronCommand(line), { workingDir: '/w', scriptPath: '/s/ingest.js' });
  const plain = ingest.buildCronLine({ exec: NVM_NODE, script: '/s/ingest.js', workdir: '/w', log: '/l' });
  assert.deepStrictEqual(ingest.parseCronCommand(plain), { workingDir: '/w', scriptPath: '/s/ingest.js' });
});

test('the REAL installer defaults bake the REAL running node dir (end-to-end, no injected paths)', () => {
  // The defect was measured on a live machine, not on injected fixtures: with no
  // `exec` argument the emitter must still carry process.execPath's directory.
  const out = ingest.buildPlist({ label: 'com.x', script: '/s', log: '/l', workdir: '/w', hivecontrol: HC });
  assert.ok(out.includes(path.dirname(process.execPath)),
    'the unit bakes process.execPath, so its directory must be on the unit PATH');
});
