'use strict';
// doctor --logs (Claim 2, v0.64.0) — reads + summarizes recent warn/error entries
// from the CENTRAL anti-hall-log (companion/lib/anti-hall-log.js's readRecent) so
// a Primary orchestrator can see a child project's failures from one place.
//
// Black-box: spawn doctor.js as a real subprocess with ANTI_HALL_LOG_DIR pointed
// at a throwaway fixture directory (the SAME test-only override anti-hall-log.js
// itself documents honoring) so this suite never touches the real
// ~/.anti-hall/logs/devswarm.jsonl. Report-only: --logs must never change the
// exit code, with or without entries present.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');
const LOG_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'anti-hall-log.js');
const logMod = require(LOG_JS);

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-logs-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// seedLog(dir, fn) — runs fn() with process.env.ANTI_HALL_LOG_DIR pointed at `dir`
// (anti-hall-log.js reads this env var LIVE, not cached — see its own logDir()
// comment) so logError/logEvent write into the fixture dir, then restores the
// prior value. Never touches the real ~/.anti-hall/logs.
function seedLog(dir, fn) {
  const prior = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = dir;
  try { fn(); } finally {
    if (prior === undefined) delete process.env.ANTI_HALL_LOG_DIR;
    else process.env.ANTI_HALL_LOG_DIR = prior;
  }
}

// timeout: generous on purpose. spawnSync's timeout kills the child (SIGTERM) and
// yields status=null on expiry — that is a legitimately-slow subprocess under
// contention, NOT a wrong exit code, and asserting strictEqual(r.code, 0) against a
// null gives a misleading "0 !== null" failure that looks like a real doctor bug.
// Proven under load (3 concurrent `node --test` full-suite runs on this machine,
// each spawning ~130 test files' worth of child processes): this same doctor
// invocation legitimately took 15021-15040ms wall-clock — just over the previous
// 15000ms cap — with NO shared state, no hung process, no signal other than the
// timeout's own SIGTERM. 60000ms keeps a real hang/crash catchable while giving
// ~4x headroom over the worst contention observed so CI parallelism doesn't flake it.
function runDoctor({ cwd, env, args }) {
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS].concat(args || []), {
    cwd, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: undefined, USERPROFILE: undefined, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
      ANTI_HALL_LOG_DIR: undefined,
    }, env || {}),
  });
  return {
    code: res.status,
    signal: res.signal,
    out: (res.stdout || '') + (res.stderr || '')
      + (res.signal ? `\n[runDoctor: process terminated by signal ${res.signal}]` : ''),
  };
}

test('doctor --logs: no log file at all -> "no warn/error entries" INFO, exits 0', () => {
  const home = mkTmp('empty-home');
  const cwd = mkTmp('empty-cwd');
  const logDir = mkTmp('empty-logdir'); // exists but never written to — no devswarm.jsonl inside
  try {
    const r = runDoctor({ cwd, args: ['--check', '--logs'], env: { HOME: home, USERPROFILE: home, ANTI_HALL_LOG_DIR: logDir } });
    assert.strictEqual(r.code, 0, '--logs must never change the exit code:\n' + r.out);
    assert.match(r.out, /Logs \(--logs: recent anti-hall-log entries\)/, 'the Logs section header must print:\n' + r.out);
    assert.match(r.out, /no warn\/error entries in the central anti-hall log/, r.out);
  } finally { rm(home); rm(cwd); rm(logDir); }
});

test('doctor: --logs OMITTED -> the Logs section never prints, even with entries present', () => {
  const home = mkTmp('omit-home');
  const cwd = mkTmp('omit-cwd');
  const logDir = mkTmp('omit-logdir');
  try {
    seedLog(logDir, () => logMod.logEvent('devswarm-send', 'send', 'warn', 'lock contention', {}));
    const r = runDoctor({ cwd, args: ['--check'], env: { HOME: home, USERPROFILE: home, ANTI_HALL_LOG_DIR: logDir } });
    assert.strictEqual(r.code, 0);
    assert.doesNotMatch(r.out, /Logs \(--logs:/, '--logs is opt-in — omitting the flag must never surface the section:\n' + r.out);
  } finally { rm(home); rm(cwd); rm(logDir); }
});

test('doctor --logs: an error + a warn entry across two components -> summarized by component, individual entries printed, exit 0', () => {
  const home = mkTmp('entries-home');
  const cwd = mkTmp('entries-cwd');
  const logDir = mkTmp('entries-logdir');
  try {
    seedLog(logDir, () => {
      logMod.logError('devswarm-ingest', 'monitor', new Error('boom crash'), { repoKey: 'proj-abc123' });
      logMod.logEvent('devswarm-send', 'send', 'warn', 'lock contention', { repoKey: 'proj-abc123' });
      logMod.logEvent('devswarm-ingest', 'sweep', 'debug', 'quiet sweep, 0 inserted', {}); // below minLevel:'warn' — must be excluded
    });
    const r = runDoctor({ cwd, args: ['--check', '--logs'], env: { HOME: home, USERPROFILE: home, ANTI_HALL_LOG_DIR: logDir } });
    assert.strictEqual(r.code, 0, 'a logged historical error must never fail THIS doctor run (report-only):\n' + r.out);
    assert.match(r.out, /2 warn\/error entries in the central anti-hall log across 2 component\(s\)/, r.out);
    assert.match(r.out, /devswarm-ingest:1/);
    assert.match(r.out, /devswarm-send:1/);
    assert.match(r.out, /error devswarm-ingest\/monitor repoKey=proj-abc123: boom crash/, r.out);
    assert.match(r.out, /warn devswarm-send\/send repoKey=proj-abc123: lock contention/, r.out);
    assert.doesNotMatch(r.out, /quiet sweep/, 'a debug-level entry below minLevel:warn must be excluded from the summary');
  } finally { rm(home); rm(cwd); rm(logDir); }
});

test('doctor --logs: works standalone with --dry-run too (not gated behind --check)', () => {
  const home = mkTmp('dryrun-home');
  const cwd = mkTmp('dryrun-cwd');
  const logDir = mkTmp('dryrun-logdir');
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    const r = runDoctor({ cwd, args: ['--dry-run', '--logs'], env: { HOME: home, USERPROFILE: home, ANTI_HALL_LOG_DIR: logDir } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Logs \(--logs: recent anti-hall-log entries\)/, r.out);
  } finally { rm(home); rm(cwd); rm(logDir); }
});
