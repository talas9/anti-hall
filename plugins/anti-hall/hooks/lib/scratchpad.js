'use strict';
// Session-scratchpad / tmp-root helpers shared by edit-guard.js and
// command-guard.js. See edit-guard.js (the "own scratchpad" comment block
// above isOwnScratchpadPath) for the full rationale and anti-bypass scoping.

const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpRoots() {
  const roots = [];
  const seen = new Set();
  const add = (r) => {
    if (typeof r === 'string' && r && !seen.has(r)) { seen.add(r); roots.push(r); }
  };
  try { add(os.tmpdir()); } catch (_) { /* ignore */ }
  add('/tmp');
  add('/private/tmp');
  return roots;
}

function ownScratchpadDirs(payload) {
  try {
    if (process.platform === 'win32') return [];
    const cwd = payload && payload.cwd;
    const sessionId = payload && payload.session_id;
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return [];
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return [];
    let uid = null;
    try { uid = typeof process.getuid === 'function' ? process.getuid() : null; } catch (_) { uid = null; }
    if (uid === null || uid === undefined || Number.isNaN(uid)) return [];
    const sanitizedCwd = cwd.replace(/\//g, '-');
    return tmpRoots().map((root) =>
      path.join(root, 'claude-' + uid, sanitizedCwd, sessionId, 'scratchpad'));
  } catch (_) {
    return []; // fail CLOSED: no exemption on any unexpected error
  }
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    // Walk up to the nearest existing ancestor.
    let cur = p;
    const suffix = [];
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // hit filesystem root without finding anything real
      suffix.unshift(path.basename(cur));
      cur = parent;
      try {
        const real = fs.realpathSync(cur);
        return path.join(real, ...suffix);
      } catch (_) {
        // keep walking up
      }
    }
  }
}

// isInsideDir(p, dir) -> true when p resolves strictly INSIDE dir, both
// sides realpath'd (realpathOrSelf: nearest existing ancestor), so `..`
// segments and symlinked components are resolved before the comparison.
function isInsideDir(p, dir) {
  try {
    const rel = path.relative(realpathOrSelf(dir), realpathOrSelf(path.resolve(p)));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (_) {
    return false;
  }
}

module.exports = { tmpRoots, ownScratchpadDirs, realpathOrSelf, isInsideDir };
