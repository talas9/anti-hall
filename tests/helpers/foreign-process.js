'use strict';
// foreign-process — run a devswarm operation in a SEPARATE node process, the way a
// concurrent sweep/hook really runs. An in-process call would share this process's
// held-lock set (devswarm.js HELD_ID_LOCKS: a lock this process holds is, correctly,
// "held by the caller"), so it cannot model a concurrent writer.
//
// runForeign(op, args, home) -> parsed JSON result. `op`: 'fold' | 'forwardArchived'.
// holdForeignLock(id, home) -> writes the per-id lock file owned by a LIVE foreign
// pid (this process's parent), so acquireLock sees a live, fresh holder -> busy.

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const SCRIPT = `
const a = JSON.parse(process.env.FOREIGN_ARGS);
const cli = require(${JSON.stringify(path.join(ROOT, 'scripts', 'devswarm.js'))});
const storeLib = require(${JSON.stringify(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'))});
const s = storeLib.openStore({ home: a.home, hash: a.hash, backend: 'journal' });
let out;
try {
  if (a.op === 'fold') {
    const cand = s.listRegistry().find((d) => String(d.id) === a.candidate);
    const r = cli.foldGroupIntoSurvivor(s, a.home, a.survivor, [cand]);
    out = { forwarded: r.forwarded, retired: r.retired, skipped: r.skipped, pending: r.pending };
  } else {
    out = cli.forwardArchivedOrphanUnread(s, a.source, a.survivor, { home: a.home });
  }
} finally { s.close(); }
process.stdout.write(JSON.stringify(out));
`;

function runForeign(op, args, home) {
  const r = cp.spawnSync(process.execPath, ['-e', SCRIPT], {
    encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, FOREIGN_ARGS: JSON.stringify(Object.assign({ op, home }, args)) },
  });
  if (r.status !== 0) throw new Error('foreign process failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function holdForeignLock(id, home) {
  const recovery = require(path.join(ROOT, 'companion', 'lib', 'recovery.js'));
  const p = recovery.lockPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: process.ppid, ts: Date.now(), token: 'foreign-holder' }));
  return () => { try { fs.unlinkSync(p); } catch (_) {} };
}

module.exports = { runForeign, holdForeignLock };
