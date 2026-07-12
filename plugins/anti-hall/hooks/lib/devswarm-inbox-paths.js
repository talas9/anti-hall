'use strict';
// anti-hall :: devswarm-inbox-paths — shared, dependency-free classifier that
// tells a guard whether a filesystem path is a RAW DevSwarm inbox/store surface
// that must only ever be read through the wrapper (devswarm.js), never opened
// directly via the Read tool or a `cat`/`head`/… shell read.
//
// WHY (accurate harm model — do NOT say "it drains the queue"):
//   The inbox is APPEND-ONLY NDJSON; a raw read does NOT drain/consume it. The
//   real harm of a direct raw read is (1) CURSOR DESYNC — the durable cursor that
//   tracks what has been consumed is bypassed, so messages get re-processed or
//   skipped — and (2) a STORE-LAYERING VIOLATION: per devswarm-store.js, "HOOKS
//   NEVER OPEN THE DB"; the store is the write/derive side only, and hooks/agents
//   read the derived projections through the wrapper, never the raw store.
//
// TAXONOMY (verified against liveness.js devswarmRoot + devswarm-store.js paths):
//   DENY  inbox/**                              -> 'deny-inbox'
//         store/devswarm.db(+ -wal/-shm/-journal) -> 'deny-store' (gated, see below)
//         store/journal/*.ndjson                  -> 'deny-store' (gated)
//   ALLOW summary.json, cursors/**, workspaces/**, liveness/**, heartbeats/**,
//         locks/**, archive-*, anything outside the devswarm root, any resolution
//         error                                 -> 'allow'
//
// SELF-HEALING store gate: the store DENY only fires when a Primary read-CLI that
// can serve store reads through the wrapper is actually present (storeReadCliPresent
// — probes for devswarm-store.js's `listMessages`). Until that CLI lands, a store
// read fails OPEN (returns 'allow') so a pre-CLI Primary is NEVER bricked. The
// inbox DENY is NOT gated — the child-side `devswarm.js inbox read <id>` wrapper
// already exists.
//
// FAIL-OPEN: every ambiguity, out-of-root path, or thrown error returns 'allow'.
// This guard is a drift-guard against accidental raw reads, not an adversary
// defense; a hook bug must never block a turn.

const os = require('os');
const path = require('path');
const { devswarmRoot } = require('../../companion/lib/liveness.js');

const STORE_MODULE_PATH = '../../companion/lib/devswarm-store.js';

// isStoreDenyTarget(rest) -> bool. `rest` is the store-relative sub-path (forward
// slashes, no leading 'store/'). DENY the SQLite db + its sidecars and any journal
// NDJSON; everything else under store/ is ALLOW (fail-open for unknown files).
//
// PER-PROJECT layout (v0.55): the store is now physically split by worktree hash —
// store/<8hex>/devswarm.db(+ sidecars) and store/<8hex>/journal/*.ndjson. The
// LEGACY flat layout (store/devswarm.db, store/journal/*.ndjson) is still matched
// so a pre-migration on-disk store stays guarded during/after upgrade.
function isStoreDenyTarget(rest) {
  // per-project: <hash>/devswarm.db(+ sidecars), <hash>/journal/*.ndjson
  if (/^[0-9a-fA-F]{8}\/devswarm\.db$/.test(rest)) return true;
  if (/^[0-9a-fA-F]{8}\/devswarm\.db-(wal|shm|journal)$/.test(rest)) return true;
  if (/^[0-9a-fA-F]{8}\/journal\/[^/]+\.ndjson$/.test(rest)) return true;
  // legacy flat (pre-per-project) layout
  if (rest === 'devswarm.db') return true;
  if (rest === 'devswarm.db-wal' || rest === 'devswarm.db-shm' || rest === 'devswarm.db-journal') return true;
  if (/^journal\/[^/]+\.ndjson$/.test(rest)) return true;
  return false;
}

// storeReadCliPresent(home, opts) -> bool. Probe whether the Primary read-CLI that
// serves store reads through the wrapper exists — detected by devswarm-store.js
// exposing a `listMessages` read surface (module-level export OR a method on a
// backend handle). The handle probe forces the JOURNAL backend, which is
// side-effect-free on open (openJournal only computes paths; it never mkdir's or
// touches a db file until a write). Any error -> false (fail-open: allow the read).
//   opts.storeModule (test seam): inject a fake module instead of require().
function storeReadCliPresent(home, opts) {
  try {
    const store = (opts && opts.storeModule) || require(STORE_MODULE_PATH);
    if (!store) return false;
    if (typeof store.listMessages === 'function') return true;
    if (typeof store.openStore === 'function') {
      let handle = null;
      try {
        handle = store.openStore({ backend: 'journal', home: home || os.homedir() });
        if (handle && typeof handle.listMessages === 'function') return true;
      } finally {
        try { if (handle && typeof handle.close === 'function') handle.close(); } catch (_) {}
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// classifyDevswarmPath(rawPath, home, cwd, opts) -> 'deny-inbox' | 'deny-store' | 'allow'.
//   rawPath : the path being read (Read tool file_path, or a shell read arg).
//   home    : the home whose ~/.anti-hall/devswarm root anchors the taxonomy.
//   cwd     : (optional) base to resolve a RELATIVE rawPath against (payload cwd);
//             defaults to home. Absolute rawPaths ignore it.
//   opts    : (optional) { storeCliPresent?: boolean, storeModule?: any } — test
//             seams; storeCliPresent forces the store-gate result without a probe.
function classifyDevswarmPath(rawPath, home, cwd, opts) {
  try {
    if (!rawPath || typeof rawPath !== 'string') return 'allow';
    const h = home || os.homedir();
    // Resolve to an absolute path (relative -> against cwd, else home).
    let abs = rawPath;
    if (!path.isAbsolute(abs)) {
      const base = (cwd && typeof cwd === 'string') ? cwd : h;
      abs = path.resolve(base, abs);
    }
    // Normalize separators to '/' (mirror edit-guard.js) and strip trailing slashes
    // so a prefix comparison against the root is exact.
    const nAbs = String(abs).replace(/\\/g, '/').replace(/\/+$/, '');
    const nRoot = String(devswarmRoot(h)).replace(/\\/g, '/').replace(/\/+$/, '');
    if (nAbs !== nRoot && !nAbs.startsWith(nRoot + '/')) return 'allow'; // outside the devswarm root
    const rel = nAbs === nRoot ? '' : nAbs.slice(nRoot.length + 1);
    if (rel === '') return 'allow'; // the root directory itself
    const seg = rel.split('/')[0];

    if (seg === 'inbox') return 'deny-inbox'; // NOT gated — the inbox read wrapper already exists.

    if (seg === 'store') {
      const rest = rel.slice('store/'.length);
      if (!isStoreDenyTarget(rest)) return 'allow';
      const present = (opts && typeof opts.storeCliPresent === 'boolean')
        ? opts.storeCliPresent
        : storeReadCliPresent(h, opts);
      return present ? 'deny-store' : 'allow';
    }

    return 'allow'; // summary.json, cursors/**, workspaces/**, liveness/**, etc.
  } catch (_) {
    return 'allow'; // fail-open on any resolution error
  }
}

module.exports = { classifyDevswarmPath, storeReadCliPresent, isStoreDenyTarget };
