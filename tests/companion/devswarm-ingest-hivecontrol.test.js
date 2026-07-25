'use strict';
// devswarm-ingest-hivecontrol.test.js — v0.66 ENOENT-storm fix.
//
// PROVEN FIELD DEFECT this file locks down: devswarm-ingest.js spawned the BARE
// name `hivecontrol` while launchd/systemd hand a unit a MINIMAL PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) that does not contain the DevSwarm CLI — so
// EVERY monitor call failed ENOENT, ~2.86/s across daemons, and the flat 2s
// retry + unconditional per-occurrence logging grew the log to 4.8MB and
// self-rotated all genuine ingest history away every ~25 minutes. Meanwhile the
// heartbeat was written BEFORE the monitor call, unconditionally, so the daemon
// still looked perfectly RUNNING.
//
// Three halves are covered here:
//   1. INSTALL: the generated unit (plist / systemd / cron) carries the resolved
//      absolute binary + a PATH containing its directory, from a PURE builder so
//      a reconcile that regenerates the unit reproduces it byte-for-byte (a
//      hand-patched plist was silently reverted; a builder-emitted one is not).
//   2. DAEMON: option > env var > bare-name PATH lookup, resolved once.
//   3. BREAKER: ENOENT/EACCES/ENOTDIR are PERMANENT (configuration) faults —
//      escalating backoff, logs only on state transitions, never one line per
//      occurrence. Transient failures keep their pre-existing behavior.
//
// HERMETIC: no real `hivecontrol` is ever spawned (that would destructively pop
// the native message queue) — every monitor run and every binary lookup is
// injected. No ambient ~/.anti-hall or DEVSWARM_* reliance.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-hc-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// A real git worktree so repoKey (and therefore the heartbeat key) resolves —
// the same posture the existing ingest tests use.
const WT = process.cwd();

// ---------------------------------------------------------------------------
// 1. DAEMON-SIDE RESOLUTION: option > env > bare-name PATH lookup
// ---------------------------------------------------------------------------

test('resolveHivecontrolBin: explicit option > env var > bare-name PATH fallback', () => {
  assert.deepEqual(
    ingest.resolveHivecontrolBin('/opt/a/hivecontrol', { ANTIHALL_DEVSWARM_HIVECONTROL: '/opt/b/hivecontrol' }),
    { bin: '/opt/a/hivecontrol', source: 'option' }, 'an explicit option wins over the env var');
  assert.deepEqual(
    ingest.resolveHivecontrolBin(undefined, { ANTIHALL_DEVSWARM_HIVECONTROL: '/opt/b/hivecontrol' }),
    { bin: '/opt/b/hivecontrol', source: 'env' }, 'the env var wins over the bare-name fallback');
  assert.deepEqual(
    ingest.resolveHivecontrolBin(undefined, {}),
    { bin: 'hivecontrol', source: 'path' }, 'no option, no env -> ordinary PATH lookup of the bare name');
  // Empty/whitespace values are NOT a resolution (a unit that baked an empty
  // env value must not spawn '').
  assert.equal(ingest.resolveHivecontrolBin('  ', { ANTIHALL_DEVSWARM_HIVECONTROL: '   ' }).source, 'path');
  assert.equal(ingest.HIVECONTROL_ENV_VAR, 'ANTIHALL_DEVSWARM_HIVECONTROL', 'the documented env var name is stable');
});

test('runIngestLoop spawns the RESOLVED binary (env var), not the bare name', () => {
  const home = tmpHome();
  try {
    const seen = [];
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2, worktree: WT,
      env: { ANTIHALL_DEVSWARM_HIVECONTROL: '/opt/devswarm/bin/hivecontrol' },
      run: (o) => { seen.push(o.hivecontrol); return { ok: true, raw: '[]' }; },
      sleep: () => {},
    });
    assert.equal(summary.started, true);
    assert.deepEqual(seen, ['/opt/devswarm/bin/hivecontrol', '/opt/devswarm/bin/hivecontrol'],
      'every iteration spawns the absolute path from the env var (resolved once, reused)');
  } finally { rm(home); }
});

test('runIngestLoop falls back to the bare name when nothing is configured (ordinary PATH lookup)', () => {
  const home = tmpHome();
  try {
    const seen = [];
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: WT,
      env: {}, run: (o) => { seen.push(o.hivecontrol); return { ok: true, raw: '[]' }; }, sleep: () => {},
    });
    assert.deepEqual(seen, ['hivecontrol'], 'no config -> bare name, resolved by the OS through PATH');
  } finally { rm(home); }
});

test('hivecontrolBinUsable: absolute+missing = false, absolute+present = true, bare name = UNKNOWN (never false)', () => {
  const home = tmpHome();
  try {
    const real = path.join(home, 'hivecontrol');
    fs.writeFileSync(real, '#!/bin/sh\n');
    assert.equal(ingest.hivecontrolBinUsable({ bin: real, source: 'env' }), true);
    assert.equal(ingest.hivecontrolBinUsable({ bin: path.join(home, 'nope'), source: 'env' }), false);
    assert.equal(ingest.hivecontrolBinUsable({ bin: 'hivecontrol', source: 'path' }), null,
      'a bare name cannot be judged up front — UNKNOWN, never a speculative failure');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 2. CLASSIFICATION + BACKOFF LADDER
// ---------------------------------------------------------------------------

test('monitorFailureCode: ENOENT/EACCES/ENOTDIR are PERMANENT; everything else is transient', () => {
  assert.equal(ingest.monitorFailureCode({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(ingest.monitorFailureCode({ code: 'EACCES' }), 'EACCES');
  assert.equal(ingest.monitorFailureCode({ code: 'ENOTDIR' }), 'ENOTDIR');
  // An injected/older runner that only supplies a message string still classifies.
  assert.equal(ingest.monitorFailureCode({ error: 'spawnSync hivecontrol ENOENT' }), 'ENOENT');
  assert.equal(ingest.monitorFailureCode({ code: 'ETIMEDOUT', error: 'timed out' }), null,
    'a hardTimeoutMs kill is TRANSIENT — it must never enter the permanent ladder');
  assert.equal(ingest.monitorFailureCode({ error: 'monitor crashed' }), null);
});

test('permanentBackoffMs escalates 2s -> 5s -> 30s -> 2m -> 5m and CAPS (production base)', () => {
  const base = 2000;
  const seq = [1, 2, 3, 4, 5, 6, 50].map((n) => ingest.permanentBackoffMs(n, base));
  assert.deepEqual(seq.slice(0, 5), [2000, 5000, 30000, 120000, 300000]);
  assert.equal(seq[5], ingest.PERMANENT_BACKOFF_CAP_MS, 'past the ladder it stays at the cap');
  assert.equal(seq[6], ingest.PERMANENT_BACKOFF_CAP_MS);
  // Strictly increasing until the cap — the actual anti-storm property.
  for (let i = 1; i < 5; i++) assert.ok(seq[i] > seq[i - 1], 'step ' + i + ' escalates');
});

test('circuit breaker: 200 identical ENOENT failures emit a BOUNDED, rolled-up set of log lines (not 200)', () => {
  const lines = [];
  const breaker = ingest.createMonitorBreaker({ baseBackoffMs: 10, log: (e) => lines.push(e) });
  const backoffs = [];
  for (let i = 0; i < 200; i++) {
    const v = breaker.onFailure({ ok: false, code: 'ENOENT', error: 'spawnSync hivecontrol ENOENT' }, 1000 + i);
    backoffs.push(v.backoffMs);
    assert.equal(v.permanent, true);
  }
  assert.ok(lines.length <= ingest.PERMANENT_BACKOFF_STEPS.length,
    '200 identical permanent failures emitted ' + lines.length + ' log line(s) (must be <= '
    + ingest.PERMANENT_BACKOFF_STEPS.length + ' — one per backoff-step transition, never one per occurrence)');
  assert.ok(lines.length >= 2, 'the first occurrence AND at least one escalation are still reported');
  assert.equal(lines[0].kind, 'monitor-run-failed-permanent');
  assert.match(lines[0].message, /ENOENT/);
  assert.match(lines[0].message, /ANTIHALL_DEVSWARM_HIVECONTROL/, 'the first line is ACTIONABLE (names the fix)');
  // A later line is a ROLLUP: it carries the occurrence count, not a bare repeat.
  const rolled = lines[lines.length - 1];
  assert.ok(rolled.ctx.consecutiveFailures > 1, 'the rolled-up line carries the occurrence count');
  assert.ok(rolled.ctx.occurrencesSinceLastLog >= 1);
  assert.equal(backoffs[0], 10, 'first retry uses the configured base backoff');
  assert.ok(backoffs[199] > backoffs[0], 'the backoff escalated away from the flat 2s retry');
});

test('circuit breaker: TRANSIENT failures keep the pre-existing per-occurrence log + flat backoff', () => {
  const lines = [];
  const breaker = ingest.createMonitorBreaker({ baseBackoffMs: 10, log: (e) => lines.push(e) });
  for (let i = 0; i < 5; i++) {
    const v = breaker.onFailure({ ok: false, code: 'ETIMEDOUT', error: 'monitor timed out' }, 1000 + i);
    assert.equal(v.permanent, false);
    assert.equal(v.backoffMs, 10, 'transient backoff stays flat (unchanged behavior)');
  }
  assert.equal(lines.length, 5, 'every transient failure is still logged individually');
  assert.equal(lines[0].kind, 'monitor-run-failed');
});

test('circuit breaker: a success RESETS the run and reports recovery exactly once', () => {
  const lines = [];
  const breaker = ingest.createMonitorBreaker({ baseBackoffMs: 10, log: (e) => lines.push(e) });
  breaker.onFailure({ code: 'ENOENT', error: 'x ENOENT' }, 1);
  breaker.onFailure({ code: 'ENOENT', error: 'x ENOENT' }, 2);
  const before = lines.length;
  breaker.onSuccess(3);
  assert.equal(lines.length, before + 1, 'recovery is reported once');
  assert.equal(lines[lines.length - 1].kind, 'monitor-run-recovered');
  assert.equal(breaker.state.consecutive, 0, 'the run is reset');
  assert.equal(breaker.state.lastOkMs, 3);
  const after = lines.length;
  breaker.onSuccess(4);
  assert.equal(lines.length, after, 'a second consecutive success says nothing');
});

// ---------------------------------------------------------------------------
// 3. DAEMON END-TO-END: degraded mode, no storm, honest heartbeat
// ---------------------------------------------------------------------------

test('unresolvable binary: ONE startup error + a BOUNDED failure log over 40 polls (no ENOENT storm)', () => {
  const home = tmpHome();
  try {
    const lines = [];
    const slept = [];
    const missing = path.join(home, 'no-such-dir', 'hivecontrol');
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 40, worktree: WT,
      env: { ANTIHALL_DEVSWARM_HIVECONTROL: missing },
      restartBackoffMs: 5,
      run: () => ({ ok: false, raw: '', error: 'spawnSync ' + missing + ' ENOENT', code: 'ENOENT' }),
      sleep: (ms) => slept.push(ms),
      io: { monitorLog: (e) => lines.push(e) },
    });
    assert.equal(summary.started, true, 'a broken binary must NOT abort daemon startup (fail-open)');
    assert.equal(summary.stats.errors, 40);
    const startup = lines.filter((l) => l.kind === 'hivecontrol-unresolvable');
    assert.equal(startup.length, 1, 'the unresolvable-binary notice is emitted EXACTLY once at startup');
    assert.match(startup[0].message, /ANTIHALL_DEVSWARM_HIVECONTROL/);
    const failures = lines.filter((l) => l.kind === 'monitor-run-failed-permanent');
    assert.ok(failures.length <= ingest.PERMANENT_BACKOFF_STEPS.length,
      '40 polls emitted ' + failures.length + ' failure line(s) — bounded, not one per poll');
    assert.equal(lines.filter((l) => l.kind === 'monitor-run-failed').length, 0,
      'a configuration fault must NOT take the transient per-occurrence path');
    assert.equal(slept.length, 39, 'still backs off between polls (no busy loop)');
    assert.ok(slept[slept.length - 1] > slept[0], 'the backoff escalated instead of staying flat');
  } finally { rm(home); }
});

test('heartbeat records the MONITOR OUTCOME — alive-but-failing is machine-detectable from the file alone', () => {
  const home = tmpHome();
  try {
    const hbPath = ingest.ingestHeartbeatPath(home, repokey.repoKeyForWorktree(WT));
    // 4 bounded iterations; the LAST one's backoff is skipped (the loop is about
    // to end), so the newest heartbeat on disk is the one written during the 3rd
    // failure's backoff. A real (unbounded) daemon always writes after every
    // failure — see backoffWithHeartbeat.
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 4, worktree: WT,
      env: { ANTIHALL_DEVSWARM_HIVECONTROL: '/opt/devswarm/bin/hivecontrol', PATH: '/usr/bin:/bin' },
      restartBackoffMs: 1,
      run: () => ({ ok: false, raw: '', error: 'spawnSync hivecontrol ENOENT', code: 'ENOENT' }),
      sleep: () => {}, io: { monitorLog: () => {} },
    });
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.consecutiveMonitorFailures, 3, 'the heartbeat carries the consecutive failure count');
    assert.equal(beat.lastMonitorOkMs, null, 'never a successful poll -> no last-ok timestamp');
    assert.equal(beat.lastMonitorErrorCode, 'ENOENT');
    assert.equal(beat.hivecontrolBin, '/opt/devswarm/bin/hivecontrol', 'the resolved binary is named in the heartbeat');
    assert.equal(beat.daemonPath, '/usr/bin:/bin', "the daemon's ACTUAL inherited PATH is recorded");
    assert.equal(typeof beat.ts, 'number', 'liveness is still reported (the daemon really is alive)');
  } finally { rm(home); }
});

test('heartbeat records lastMonitorOkMs and clears the failure count on a successful poll', () => {
  const home = tmpHome();
  try {
    const hbPath = ingest.ingestHeartbeatPath(home, repokey.repoKeyForWorktree(WT));
    let n = 0;
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 4, worktree: WT,
      env: {}, restartBackoffMs: 1, now: 777000,
      run: () => (++n <= 2
        ? { ok: false, raw: '', error: 'spawnSync hivecontrol ENOENT', code: 'ENOENT' }
        : { ok: true, raw: '[]' }),
      sleep: () => {}, io: { monitorLog: () => {} },
    });
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.consecutiveMonitorFailures, 0, 'a success clears the failure count');
    assert.equal(beat.lastMonitorOkMs, 777000, 'the successful poll stamps lastMonitorOkMs');
    assert.equal(beat.lastMonitorErrorCode, null);
  } finally { rm(home); }
});

test('a LONG permanent backoff is slept in slices that keep heartbeating (never reads as a DEAD daemon)', () => {
  const home = tmpHome();
  try {
    const hbPath = ingest.ingestHeartbeatPath(home, repokey.repoKeyForWorktree(WT));
    const slept = [];
    // Base 300s => the very first backoff is already the 5-minute cap, which is
    // LONGER than the 3-minute staleness window every consumer judges liveness
    // by. Sleeping it in one call would make a correctly-backing-off daemon read
    // as STOPPED.
    ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 2, worktree: WT,
      env: {}, restartBackoffMs: 300000, now: 555000,
      run: () => ({ ok: false, raw: '', error: 'spawnSync hivecontrol ENOENT', code: 'ENOENT' }),
      sleep: (ms) => slept.push(ms), io: { monitorLog: () => {} },
    });
    assert.ok(slept.length > 1, 'a 5-minute backoff is sliced, not slept in one call');
    for (const ms of slept) assert.ok(ms <= 60000, 'no slice exceeds 60s (heartbeat stays fresh): ' + ms);
    assert.equal(slept.reduce((a, b) => a + b, 0), 300000, 'the TOTAL backoff is preserved exactly');
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.equal(beat.ts, 555000, 'the daemon keeps heartbeating THROUGH the backoff');
    assert.equal(beat.consecutiveMonitorFailures, 1, 'and the heartbeat carries the live failure count');
  } finally { rm(home); }
});

test('a batch drained by a FAILING monitor call is still ingested BEFORE the backoff (no regression)', () => {
  const home = tmpHome();
  try {
    // `hivecontrol workspace monitor` is DESTRUCTIVE: stdout written before a
    // kill is already popped off the native queue and can never be re-observed.
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', maxIterations: 1, worktree: WT,
      env: {}, restartBackoffMs: 1,
      run: () => ({ ok: false, raw: '[{"message":"drained before the kill"}]', error: 'timed out', code: 'ETIMEDOUT' }),
      sleep: () => {}, io: { monitorLog: () => {} },
    });
    assert.equal(summary.stats.inserted, 1, 'the drained batch was ingested even though the call failed');
    assert.equal(summary.stats.errors, 1, 'and the attempt still counted as a failure for backoff');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 4. INSTALLER: discovery (never a hardcoded path) + baked, byte-stable unit env
// ---------------------------------------------------------------------------

function makeBin(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n');
  try { fs.chmodSync(p, 0o755); } catch (_) {}
  return p;
}

test('resolveHivecontrolPath discovers the binary via the LOGIN shell (never a hardcoded root)', () => {
  const home = tmpHome();
  try {
    const bin = makeBin(path.join(home, 'tools', 'bin'), 'hivecontrol');
    const calls = [];
    const got = installer.resolveHivecontrolPath({
      platform: 'darwin', env: { SHELL: '/bin/zsh' },
      io: {
        lookupRun: (spec) => {
          calls.push(spec.cmd + ' ' + spec.args.join(' '));
          // Interactive login shell: real rc files print noise around the answer.
          return { ok: true, raw: 'zsh: no job control in this shell\n' + bin + '\n' };
        },
      },
    });
    assert.equal(got, bin, 'the discovered absolute path is returned');
    assert.equal(calls.length, 1, 'the interactive login shell is tried FIRST (it is where most users export PATH)');
    assert.match(calls[0], /^\/bin\/zsh -lic command -v hivecontrol$/, 'uses the user\'s own $SHELL as a login shell');
  } finally { rm(home); }
});

test('resolveHivecontrolPath: env override wins, noise-only output falls through, nothing found -> null', () => {
  const home = tmpHome();
  try {
    const bin = makeBin(path.join(home, 'b'), 'hivecontrol');
    assert.equal(
      installer.resolveHivecontrolPath({
        platform: 'darwin', env: { ANTIHALL_DEVSWARM_HIVECONTROL: bin },
        io: { lookupRun: () => { throw new Error('must not be consulted'); } },
      }), bin, 'an explicit env var short-circuits the shell probe entirely');

    // A shell that answers with unrelated noise (or a path whose basename is not
    // the binary) must never be mistaken for a resolution.
    const attempts = [];
    assert.equal(
      installer.resolveHivecontrolPath({
        platform: 'darwin', env: {},
        io: { lookupRun: (s) => { attempts.push(s.args[0]); return { ok: true, raw: '/etc/profile.d/x.sh\nsome warning\n' }; } },
      }), null, 'noise is filtered — no guessing');
    assert.deepEqual(attempts, ['-lic', '-lc', '-c'], 'all three lookup strategies are attempted, in order');

    assert.equal(
      installer.resolveHivecontrolPath({ platform: 'darwin', env: {}, io: { lookupRun: () => ({ ok: false, raw: '' }) } }),
      null, 'a failing lookup resolves to null (the installer then warns and installs anyway)');
    assert.equal(
      installer.resolveHivecontrolPath({ platform: 'win32', env: {}, io: { lookupRun: () => { throw new Error('no'); } } }),
      null, 'win32 is a documented no-op — never probes, never throws');
  } finally { rm(home); }
});

test('unitEnvFor prepends the resolved bin dir to the scheduler PATH and pins the absolute binary', () => {
  const env = installer.unitEnvFor('/opt/devswarm/cli/hivecontrol');
  assert.equal(env.PATH, '/opt/devswarm/cli:' + installer.MINIMAL_UNIT_PATH,
    'the bin dir is PREPENDED to (never replaces) the scheduler default PATH');
  assert.equal(env.ANTIHALL_DEVSWARM_HIVECONTROL, '/opt/devswarm/cli/hivecontrol',
    'the explicit absolute binary is baked too — PATH alone fixes only one lookup');
  assert.equal(installer.unitEnvFor(null), null);
  assert.equal(installer.unitEnvFor('hivecontrol'), null, 'a relative name is never baked');
  // No duplicate entry when the bin dir is already part of the default PATH.
  assert.equal(installer.unitEnvFor('/usr/bin/hivecontrol').PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('buildPlist bakes EnvironmentVariables and is BYTE-STABLE across regeneration (survives reconcile)', () => {
  const args = { label: 'com.x', exec: '/usr/bin/node', script: '/s/ingest.js', log: '/l', workdir: '/w', hivecontrol: '/opt/dv/bin/hivecontrol' };
  const a = installer.buildPlist(args);
  const b = installer.buildPlist(args);
  assert.equal(a, b, 'two consecutive builds are byte-identical — a reconcile cannot drop the env');
  assert.match(a, /<key>EnvironmentVariables<\/key>/);
  assert.match(a, /<key>ANTIHALL_DEVSWARM_HIVECONTROL<\/key>\s*<string>\/opt\/dv\/bin\/hivecontrol<\/string>/);
  assert.match(a, /<key>PATH<\/key>\s*<string>\/opt\/dv\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  // Unresolved -> the key is omitted entirely (valid plist, pre-v0.66 shape).
  const none = installer.buildPlist({ label: 'com.x', exec: '/n', script: '/s', log: '/l', workdir: '/w' });
  assert.ok(!/EnvironmentVariables/.test(none), 'no resolution -> no environment key (never an empty dict)');
  assert.equal((a.match(/<dict>/g) || []).length, (a.match(/<\/dict>/g) || []).length, 'plist stays well-formed');
  // A hostile path is refused rather than emitted (existing safety posture).
  const nasty = installer.buildPlist(Object.assign({}, args, { hivecontrol: '/opt/"evil"/hivecontrol' }));
  assert.ok(!/EnvironmentVariables/.test(nasty), 'a quote-carrying path is never emitted into a unit');
});

test('buildService bakes Environment= lines (systemd equivalent) and is byte-stable', () => {
  const args = { exec: '/usr/bin/node', script: '/s/ingest.js', workdir: '/w', hivecontrol: '/opt/dv/bin/hivecontrol' };
  const a = installer.buildService(args);
  assert.equal(a, installer.buildService(args), 'byte-stable across regeneration');
  assert.match(a, /^Environment="PATH=\/opt\/dv\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"$/m);
  assert.match(a, /^Environment="ANTIHALL_DEVSWARM_HIVECONTROL=\/opt\/dv\/bin\/hivecontrol"$/m);
  assert.ok(a.indexOf('Environment=') < a.indexOf('ExecStart='), 'environment is declared before ExecStart');
  assert.ok(!/Environment=/.test(installer.buildService({ exec: '/n', script: '/s' })), 'omitted when unresolved');
  // systemd expands % specifiers inside Environment= — they must be escaped.
  assert.match(installer.sdEnvValue('PATH=/a%b'), /%%/);
});

test('buildCronLine bakes an assignment prefix AND the readback still parses (parser + emitter stay in sync)', () => {
  const line = installer.buildCronLine({ exec: '/usr/bin/node', script: '/s/ingest.js', workdir: '/w', log: '/l', hivecontrol: '/opt/dv/bin/hivecontrol' });
  assert.match(line, /PATH='\/opt\/dv\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin'/);
  assert.match(line, /ANTIHALL_DEVSWARM_HIVECONTROL='\/opt\/dv\/bin\/hivecontrol'/);
  // The readback (doctor's install-shape classifier) must still see the REAL
  // script path, not the first baked env value.
  const parsed = installer.parseCronCommand(line);
  assert.equal(parsed.workingDir, '/w');
  assert.equal(parsed.scriptPath, '/s/ingest.js', 'the env prefix is stripped before tokenizing');
  const plain = installer.buildCronLine({ exec: '/usr/bin/node', script: '/s/ingest.js', workdir: '/w', log: '/l' });
  assert.deepEqual(installer.parseCronCommand(plain), { workingDir: '/w', scriptPath: '/s/ingest.js' },
    'a pre-v0.66 (prefix-less) cron line still parses identically');
});
