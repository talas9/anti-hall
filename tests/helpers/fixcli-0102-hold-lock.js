'use strict';
// fixcli-0102-hold-lock.js — one participant in the D5 send-lock-contention
// regression test (tests/scripts/devswarm-fixcli-0102-d5-send-lock-retry.test.js).
// Run ONLY as a spawned child process (never required directly): holds the
// per-id advisory lock (companion/lib/recovery.js acquireLock) for `holdMs`
// milliseconds in a SEPARATE OS process, so a concurrent test process's
// synchronous, Atomics.wait-blocking lock-acquisition retry (devswarm.js's
// acquireIdLock) genuinely contends against a LIVE holder instead of racing
// itself inside one thread (which node's single-threaded Atomics.wait cannot
// do — the main thread blocks itself for the whole poll).
// argv: [pluginDir, home, id, holdMs, readyFilePath]
const fs = require('fs');
const path = require('path');

const pluginDir = process.argv[2];
const home = process.argv[3];
const id = process.argv[4];
const holdMs = Number(process.argv[5]);
const readyFile = process.argv[6];

const recovery = require(path.join(pluginDir, 'companion/lib/recovery.js'));
const release = recovery.acquireLock(id, home);
if (typeof release !== 'function') {
  process.stderr.write('fixcli-0102-hold-lock: could not acquire lock\n');
  process.exit(1);
}
fs.writeFileSync(readyFile, String(process.pid));
const sab = new SharedArrayBuffer(4);
const ia = new Int32Array(sab);
Atomics.wait(ia, 0, 0, holdMs);
release();
process.exit(0);
