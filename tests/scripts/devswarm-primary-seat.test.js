'use strict';
// PRIMARY SEAT (v0.108.0, owner feature). The Primary seat (anchor
// `primary-<hash>` + its recorded session) must survive session replacement:
// a closed holder is ADOPTED by the new session (same id, partitions, cursors;
// newest worktree handover named); a LIVE holder is never displaced silently
// (warning + send/ack/spawn refused until `primary takeover`); unknown liveness
// warns and does not adopt; a stale resume is named.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-seat-log-'));
const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const drift = require(path.join(ROOT, 'companion', 'lib', 'primary-session-drift.js'));
const seat = require(path.join(ROOT, 'companion', 'lib', 'primary-seat.js'));
const { testHook } = require('../helpers/spawn-hook.js');

const HOOK_ENV = { DEVSWARM_REPO_ID: 'repo-1', ANTIHALL_DEVSWARM_APP_DB: 'off' };

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-seat-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-seat-repo-')));
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const id = inst.primaryWorkspaceId(repo);
  const env = (sid) => Object.assign({ CLAUDE_CODE_SESSION_ID: sid }, HOOK_ENV);
  const ctx = (sid, extra) => Object.assign({ home, env: env(sid), cwd: repo }, extra || {});
  return { home, repo, id, env, ctx, cleanup() { rm(home); rm(repo); } };
}
function sessionFile(f, sid, pid) {
  fs.writeFileSync(path.join(f.home, '.claude', 'sessions', sid + '.json'), JSON.stringify({ pid: pid || process.pid, sessionId: sid, cwd: f.repo }));
}
function endSession(f, sid) { rm(path.join(f.home, '.claude', 'sessions', sid + '.json')); }
function transcript(f, sid, iso) {
  const dir = drift.projectDirFor(f.repo, f.home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ type: 'user', cwd: f.repo, sessionId: sid, timestamp: iso }) + '\n');
}
function handover(f, sid, date, mtimeMs) {
  const d = path.join(f.repo, '.anti-hall', 'handovers', date, sid);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, 'HANDOVER.md');
  fs.writeFileSync(p, '# handover ' + sid + '\n');
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}
function anchorSid(f) {
  return JSON.parse(fs.readFileSync(path.join(f.home, '.anti-hall', 'devswarm', 'workspaces', f.id + '.json'), 'utf8')).sessionId;
}
function sessionStart(f, sid) {
  const r = testHook('devswarm-child-role.js', { hook_event_name: 'SessionStart', session_id: sid, cwd: f.repo, source: 'resume' },
    { home: f.home, env: HOOK_ENV, expectJson: true });
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function prompt(f, sid) {
  const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi', cwd: f.repo },
    { home: f.home, env: HOOK_ENV, expectJson: true });
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('(a) /clear -> new session heartbeating -> app restart resumes the OLD session: it adopts the SAME Primary id and names the newest worktree handover; no stand-down', () => {
  const f = fixture();
  try {
    sessionFile(f, 'sess-A');
    assert.equal(cli.run(['register-primary'], f.ctx('sess-A')).result.ok, true);
    transcript(f, 'sess-A', '2026-09-24T10:00:00.000Z');
    handover(f, 'sess-A', '2026-09-24', Date.parse('2026-09-24T12:00:00Z'));
    // /clear: the same process now runs sess-B; sess-A's session file is gone.
    endSession(f, 'sess-A');
    sessionFile(f, 'sess-B');
    transcript(f, 'sess-B', '2026-09-24T15:00:00.000Z');
    const t = cli.run(['inbox', 'tick', f.id], f.ctx('sess-B'));
    assert.equal(t.result.anchorRefresh && t.result.anchorRefresh.to, 'sess-B', 'the live successor took the anchor on its tick');
    const newest = handover(f, 'sess-B', '2026-09-24', Date.parse('2026-09-24T18:58:00Z'));
    // App restart: sess-B's process is gone; the app resumes sess-A.
    endSession(f, 'sess-B');
    sessionFile(f, 'sess-A');
    const out = sessionStart(f, 'sess-A');
    assert.match(out, new RegExp('adopted Primary ' + f.id + ' from sess-B'), out);
    assert.ok(out.includes('handover ' + newest), 'the newest HANDOVER for the WORKTREE (another session\'s), not sess-A\'s own');
    assert.match(out, /you resumed sess-A but sess-B was active until/);
    assert.doesNotMatch(out, /SEAT CONFLICT/);
    assert.equal(anchorSid(f), 'sess-A', 'same Primary id, anchor now records the resumed session');
    const s = cli.run(['send', '--broadcast', '--message', 'back'], f.ctx('sess-A'));
    assert.equal(s.result.ok, true, JSON.stringify(s.result));
    assert.equal(s.result.from, f.id, 'still sends as the one Primary id — no new identity minted');
  } finally { f.cleanup(); }
});

test('(b) both sessions alive: the second gets the blocking warning; send/ack/spawn refuse until `primary takeover`', () => {
  const f = fixture();
  try {
    sessionFile(f, 'sess-A');
    assert.equal(cli.run(['register-primary'], f.ctx('sess-A')).result.ok, true);
    sessionFile(f, 'sess-C');
    const out = sessionStart(f, 'sess-C');
    assert.match(out, /Another live Primary session sess-A owns this worktree — continue here \(it will be demoted\) or switch to it\?/, out);
    assert.equal(anchorSid(f), 'sess-A', 'never adopted from a live holder');
    const p1 = prompt(f, 'sess-C');
    assert.match(p1, /Another live Primary session sess-A owns this worktree/, 'repeated at the first UserPromptSubmit');
    assert.doesNotMatch(prompt(f, 'sess-C'), /Another live Primary session/, 'only once more');

    const send = cli.run(['send', '--broadcast', '--message', 'x'], f.ctx('sess-C'));
    assert.equal(send.code, 2);
    assert.equal(send.result.reason, 'primary-seat-conflict');
    assert.equal(cli.run(['inbox', 'ack-primary', f.id, '--receipt', 'r1'], f.ctx('sess-C')).result.reason, 'primary-seat-conflict');
    assert.equal(cli.run(['inbox', 'ack', f.id], f.ctx('sess-C')).result.reason, 'primary-seat-conflict');
    assert.equal(cli.run(['spawn', 'feat/x'], f.ctx('sess-C', { io: { run: () => { throw new Error('must not reach hivecontrol'); } } })).result.reason, 'primary-seat-conflict');
    // The holder itself is unaffected.
    assert.equal(cli.run(['send', '--broadcast', '--message', 'holder'], f.ctx('sess-A')).result.ok, true);

    const tk = cli.run(['primary', 'takeover'], f.ctx('sess-C'));
    assert.equal(tk.result.ok, true, JSON.stringify(tk.result));
    assert.equal(tk.result.demoted, 'sess-A');
    assert.equal(anchorSid(f), 'sess-C');
    assert.equal(cli.run(['send', '--broadcast', '--message', 'now mine'], f.ctx('sess-C')).result.ok, true);
    const old = cli.run(['send', '--broadcast', '--message', 'stale'], f.ctx('sess-A'));
    assert.equal(old.result.reason, 'primary-seat-conflict', 'the demoted session can no longer send as the Primary');
  } finally { f.cleanup(); }
});

test('unknown liveness (no harness session files, fresh heartbeat): warn, never adopt', () => {
  const f = fixture();
  try {
    assert.equal(cli.run(['register-primary'], f.ctx('sess-A')).result.ok, true);
    rm(path.join(f.home, '.claude', 'sessions'));
    const hb = path.join(f.home, '.anti-hall', 'devswarm', 'heartbeats', f.id + '.json');
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.writeFileSync(hb, JSON.stringify({ id: f.id, ts: Date.now() }));
    const v = seat.seatVerdict({ home: f.home, env: f.env('sess-Z'), cwd: f.repo, sessionId: 'sess-Z' });
    assert.equal(v.state, 'unknown');
    const out = sessionStart(f, 'sess-Z');
    assert.match(out, /could not verify whether session sess-A .* NOT adopting/);
    assert.equal(anchorSid(f), 'sess-A');
    // Stale heartbeat -> closed -> adoptable.
    fs.writeFileSync(hb, JSON.stringify({ id: f.id, ts: Date.now() - seat.SEAT_HEARTBEAT_STALE_MS - 1000 }));
    assert.equal(seat.seatVerdict({ home: f.home, env: f.env('sess-Z'), cwd: f.repo, sessionId: 'sess-Z' }).state, 'adopt');
  } finally { f.cleanup(); }
});

test('child worktree and non-Primary sessions are untouched (n/a)', () => {
  const f = fixture();
  try {
    const child = path.join(path.dirname(f.repo), path.basename(f.repo) + '-child');
    cp.spawnSync('git', ['-C', f.repo, 'worktree', 'add', '-q', child, '-b', 'kid']);
    try {
      assert.equal(seat.seatVerdict({ home: f.home, env: f.env('s'), cwd: child, sessionId: 's' }).state, 'n/a');
    } finally { rm(child); }
  } finally { f.cleanup(); }
});

// Identity review (race): adoption is check-then-write under the Primary id's
// lock (scripts/devswarm.js's withIdLock, acquireIdLock budgetMs default
// 2000). Two sessions adopting a closed seat AT THE SAME TIME (two real
// processes) -> exactly one adopts; the other re-reads the seat after the
// winner's write and gets the conflict notice, never a silent overwrite.
//
// DETERMINISM (defect #21, flaked once on macOS CI): under load, the loser's
// acquireIdLock can exceed its internal 2000ms budget before the winner's
// withIdLock(...) call returns, in which case adoptPrimarySeat fails CLOSED
// (documented, intentional: primary-seat.js "only a genuinely live-contended
// mutation is refused, and the caller may retry") and reports state 'unknown'
// (lockBusy) instead of 'conflict' -- a legitimate transient, not a real bug.
// A bare single-shot Promise.all([...]) treated that transient as a failure.
// Fixed with two independent, non-timing-based techniques:
//   1. A BARRIER: both child processes are spawned first, and neither writes
//      its stdin (which is what actually starts the SessionStart work) until
//      BOTH processes' 'spawn' events have fired -- so the two race the lock
//      together instead of leaving it to spawn-latency luck.
//   2. BOUNDED RETRY: a result that is neither an adoption nor a conflict
//      notice re-runs SessionStart for that same session (a fresh, outside-
//      any-lock-contention check) with exponential backoff, capped at a fixed
//      wall-clock deadline -- never a fixed sleep-then-hope guess about who
//      wins.
test('concurrent adoption: two live sessions race for a closed seat -> exactly one adopts, the loser gets the conflict notice', async () => {
  const f = fixture();
  try {
    sessionFile(f, 'sess-A');
    assert.equal(cli.run(['register-primary'], f.ctx('sess-A')).result.ok, true);
    endSession(f, 'sess-A');
    sessionFile(f, 'sess-B');
    sessionFile(f, 'sess-D');
    const hook = path.join(ROOT, 'hooks', 'devswarm-child-role.js');
    const SETTLED_RE = /adopted Primary |Another live Primary session/;

    function spawnSessionStart(sid) {
      const p = cp.spawn(process.execPath, [hook], {
        env: Object.assign({}, process.env, { HOME: f.home, USERPROFILE: f.home }, HOOK_ENV),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const outcome = new Promise((resolve) => {
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', () => {
          let ctx = '';
          try { ctx = JSON.parse(out).hookSpecificOutput.additionalContext || ''; } catch (_) { ctx = out; }
          resolve({ sid, ctx });
        });
      });
      return { sid, p, outcome };
    }

    // 1. BARRIER: spawn both children, then hold their stdin (the write that
    // actually triggers the SessionStart payload) until BOTH processes exist.
    const procs = [spawnSessionStart('sess-B'), spawnSessionStart('sess-D')];
    await Promise.all(procs.map(({ p }) => new Promise((resolve) => p.once('spawn', resolve))));
    for (const { sid, p } of procs) {
      p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, cwd: f.repo, source: 'resume' }));
    }
    const initial = await Promise.all(procs.map(({ outcome }) => outcome));

    // 2. BOUNDED RETRY: only for a result that settled into neither an
    // adoption nor a conflict notice (the lockBusy/'unknown' transient) --
    // re-check that SAME session fresh, outside any lock contention, with
    // exponential backoff capped at a fixed deadline.
    async function ensureSettled(result) {
      if (SETTLED_RE.test(result.ctx)) return result;
      const deadline = Date.now() + 5000;
      let delayMs = 25;
      let ctx = result.ctx;
      while (Date.now() < deadline && !SETTLED_RE.test(ctx)) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 250);
        ctx = (await spawnSessionStart(result.sid).outcome).ctx;
      }
      return { sid: result.sid, ctx };
    }
    const results = await Promise.all(initial.map(ensureSettled));

    const adopted = results.filter((r) => /adopted Primary /.test(r.ctx));
    assert.equal(adopted.length, 1, 'exactly one adopter: ' + JSON.stringify(results.map((r) => r.ctx.slice(0, 200))));
    const winner = adopted[0].sid;
    const loser = results.find((r) => r.sid !== winner);
    assert.match(loser.ctx, new RegExp('Another live Primary session ' + winner + ' owns this worktree'), 'the loser is told, not silently blocked: ' + loser.ctx.slice(0, 400));
    assert.equal(anchorSid(f), winner);
  } finally { f.cleanup(); }
});
