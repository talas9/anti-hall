'use strict';
// partition-lock-probe — records, for EVERY store row write (handle.appendMeshRow /
// handle.appendMessage), the destination partition and whether THIS process holds
// that partition's per-id lock file (companion/lib/recovery.js lockPathFor) at that
// instant. That is the invariant rehome relies on: any row written into partition X
// is written while X's lock is held, so it can never land between a rehome's
// snapshot and its tombstone.
//
// In-process: const probe = require(this).install(); ... probe.records; probe.uninstall().
// Subprocess: NODE_OPTIONS='--require <this file>' + PARTITION_LOCK_PROBE_OUT=<ndjson path>.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

function install(outFile) {
  const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
  const recovery = require(path.join(ROOT, 'companion', 'lib', 'recovery.js'));
  const records = [];
  const origOpen = storeLib.openStore;
  storeLib.openStore = function probedOpenStore(o) {
    const h = origOpen.apply(this, arguments);
    const home = (o && o.home) || os.homedir();
    for (const m of ['appendMeshRow', 'appendMessage']) {
      const orig = h && h[m];
      if (typeof orig !== 'function') continue;
      h[m] = function probedAppend(row) {
        const dest = row && row.workspaceId != null ? String(row.workspaceId) : null;
        let held = false;
        try { held = JSON.parse(fs.readFileSync(recovery.lockPathFor(dest, home), 'utf8')).pid === process.pid; } catch (_) { held = false; }
        const rec = { dest, held, via: m, body: row && row.body != null ? String(row.body) : null };
        records.push(rec);
        if (outFile) { try { fs.appendFileSync(outFile, JSON.stringify(rec) + '\n'); } catch (_) {} }
        return orig.apply(this, arguments);
      };
    }
    return h;
  };
  return { records, uninstall() { storeLib.openStore = origOpen; } };
}

function readRecords(outFile) {
  try { return fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
}

if (process.env.PARTITION_LOCK_PROBE_OUT) install(process.env.PARTITION_LOCK_PROBE_OUT);

module.exports = { install, readRecords };
