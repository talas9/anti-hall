'use strict';
// R15 item 6 (P3) — PID-REUSE GUARD for `pidIsAlive`/`sessionPidAlive`
// (companion/lib/liveness.js). `process.kill(pid, 0)` only proves SOME
// process currently holds that pid — never that it is the SAME process a
// session file recorded. OS pids are recycled, so a long-dead session's pid
// can be handed to a brand-new, unrelated process by the time this check
// runs, and the pre-fix code would read that as still alive.
//
// Fix: compare the live process's OWN start time (`ps -o lstart=`, fail-soft,
// injectable) against the session file's own mtime; a process that started
// AFTER the file was written cannot be the one it recorded.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVENESS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js');
const liveness = require(LIVENESS);

function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-pidreuse-'));
  return d;
}
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
function writeSessionFile(home, pid, sessionId, mtimeMs) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, String(pid) + '.json');
  fs.writeFileSync(p, JSON.stringify({ pid, sessionId, cwd: '/tmp/x', status: 'shell' }));
  if (Number.isFinite(mtimeMs)) {
    const s = mtimeMs / 1000;
    fs.utimesSync(p, s, s);
  }
  return p;
}

const aliveKill = () => { /* process.kill(pid, 0) succeeds silently */ };

test('item 6: pidIsAlive alone (no opts) is unaffected — pre-existing behavior preserved', () => {
  assert.strictEqual(liveness.pidIsAlive(999, aliveKill), true);
  const dead = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };
  assert.strictEqual(liveness.pidIsAlive(999, dead), false);
});

test('item 6: a live pid whose process started AFTER sinceMs is a REUSED pid — not alive', () => {
  const fileMtime = Date.now() - (60 * 60 * 1000); // 1h ago
  const processStart = Date.now(); // started just now — AFTER the file
  const ps = () => new Date(processStart).toString(); // `ps -o lstart=` stand-in
  assert.strictEqual(
    liveness.pidIsAlive(999, aliveKill, { sinceMs: fileMtime, ps }),
    false,
    'a process that started after the session file was written cannot be the recorded session'
  );
});

test('item 6: a live pid whose process started BEFORE sinceMs is genuinely the same session', () => {
  const processStart = Date.now() - (2 * 60 * 60 * 1000); // 2h ago
  const fileMtime = Date.now() - (60 * 60 * 1000); // 1h ago — file written AFTER process start
  const ps = () => new Date(processStart).toString();
  assert.strictEqual(
    liveness.pidIsAlive(999, aliveKill, { sinceMs: fileMtime, ps }),
    true
  );
});

test('item 6: an unparseable/unavailable `ps` fails SOFT — leaves the pre-existing alive verdict', () => {
  const fileMtime = Date.now() - (60 * 60 * 1000);
  assert.strictEqual(liveness.pidIsAlive(999, aliveKill, { sinceMs: fileMtime, ps: () => null }), true);
  assert.strictEqual(liveness.pidIsAlive(999, aliveKill, { sinceMs: fileMtime, ps: () => 'not a date' }), true);
  assert.strictEqual(liveness.pidIsAlive(999, aliveKill, { sinceMs: fileMtime, ps: () => { throw new Error('no ps binary'); } }), true);
});

test('item 6: end-to-end via sessionPidAlive — a reused pid on a stale session file reads DEAD', () => {
  const home = tmpHome();
  try {
    const fileMtime = Date.now() - (3 * 60 * 60 * 1000); // 3h old session file
    writeSessionFile(home, 5050, 'sess-reuse', fileMtime);
    const processStart = Date.now() - (5 * 60 * 1000); // the CURRENT process started 5 minutes ago — long after the file
    const ps = () => new Date(processStart).toString();
    assert.strictEqual(
      liveness.sessionPidAlive('sess-reuse', home, { kill: aliveKill, ps }),
      false,
      'a live-but-reused pid must not be read as proof this session is alive'
    );
  } finally { rm(home); }
});

test('item 6: end-to-end via sessionPidAlive — the SAME long-running process still reads ALIVE', () => {
  const home = tmpHome();
  try {
    const processStart = Date.now() - (5 * 60 * 60 * 1000); // started 5h ago
    const fileMtime = Date.now() - (3 * 60 * 60 * 1000); // file written 3h ago — after process start
    writeSessionFile(home, 5051, 'sess-real', fileMtime);
    const ps = () => new Date(processStart).toString();
    assert.strictEqual(
      liveness.sessionPidAlive('sess-real', home, { kill: aliveKill, ps }),
      true
    );
  } finally { rm(home); }
});

test('MUTATION: removing the sinceMs/ps guard from pidIsAlive restores the reused-pid false positive', () => {
  const src = fs.readFileSync(LIVENESS, 'utf8');
  const target = "if (Number.isFinite(startMs) && startMs > o.sinceMs) return false; // reused pid: a NEWER process, not the one recorded";
  assert.ok(src.includes(target), 'mutant target string not found verbatim');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-liveness-mutant-'));
  const scratchFile = path.join(scratchDir, 'liveness.js');
  try {
    fs.writeFileSync(scratchFile, src.replace(target, '// (guard removed by mutant)'));
    // liveness.js requires sibling lib files by relative path (./target-session.js,
    // ./devswarm-unread.js) — symlink them in so the scratch copy resolves exactly
    // like the real file, module-identity-preserving (mirrors devswarm-mutant-kit.js).
    const libDir = path.join(LIVENESS, '..');
    for (const sib of fs.readdirSync(libDir)) {
      if (sib === 'liveness.js') continue;
      fs.symlinkSync(path.join(libDir, sib), path.join(scratchDir, sib));
    }
    delete require.cache[require.resolve(scratchFile)];
    const mutated = require(scratchFile);
    delete require.cache[require.resolve(scratchFile)];
    const fileMtime = Date.now() - (60 * 60 * 1000);
    const processStart = Date.now();
    const ps = () => new Date(processStart).toString();
    assert.strictEqual(
      mutated.pidIsAlive(999, aliveKill, { sinceMs: fileMtime, ps }),
      true,
      'MUTANT must reproduce the reused-pid false positive'
    );
  } finally { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {} }
});
