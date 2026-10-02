'use strict';
// doctor self-tests run against an ISOLATED home, not the caller's. Before the fix,
// runHook() spawned each hook with the caller's env, so an unexpired git-guard skip
// (~/.anti-hall/skip.json) made the git-guard self-tests report FAILED, and an
// exhausted Codex quota (~/.anti-hall/codex-availability.json) did the same for
// codex-nudge: false red in `doctor --check` although the guards work.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DOCTOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ } };

function runDoctorCheck(home, tmp) {
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd: tmp, encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp }),
  });
  return (res.stdout || '') + (res.stderr || '');
}

test('self-tests ignore the caller home skip + exhausted Codex quota, and the temp home is removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  fs.mkdirSync(tmp);
  try {
    const future = Date.now() + 60 * 60 * 1000;
    fs.writeFileSync(path.join(home, '.anti-hall', 'skip.json'), JSON.stringify({ 'git-guard': future }));
    fs.writeFileSync(path.join(home, '.anti-hall', 'codex-availability.json'), JSON.stringify({
      available: true, checkedAt: Date.now(), source: 'path-probe',
      quota: { available: false, until: future, reason: 'quota exhausted', recordedAt: Date.now() },
    }));
    const out = runDoctorCheck(home, tmp);
    assert.match(out, /git-guard blocks `git push --force`/);
    assert.doesNotMatch(out, /git-guard did NOT block/);
    assert.match(out, /codex-nudge flags substantial code change/);
    assert.doesNotMatch(out, /codex-nudge did NOT flag/);
    // doctor's own temp home (prefix `anti-hall-doctor-`) is gone after the run
    assert.deepStrictEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('anti-hall-doctor-')), []);
  } finally { rm(root); }
});
