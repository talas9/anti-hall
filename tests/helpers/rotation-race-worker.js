'use strict';
// rotation-race-worker.js — one participant in the anti-hall-log.js
// concurrent-rotation regression test (tests/companion/anti-hall-log.test.js).
// Run ONLY as a worker_thread (never required directly): waits on a shared
// Int32Array barrier so every participant's logEvent() call fires as close
// to simultaneously as possible — real OS-thread concurrency (libuv runs
// synchronous fs calls off the main thread per worker), which reproduces the
// original 32-process concurrent-rotation data-loss bug far more reliably
// than staggered child-process spawns.
const { workerData } = require('worker_threads');

const { i, dir, sabBuffer, modulePath } = workerData;
process.env.ANTI_HALL_LOG_DIR = dir;
// eslint-disable-next-line import/no-dynamic-require
const mod = require(modulePath);

const sab = new Int32Array(sabBuffer);
Atomics.wait(sab, 0, 0); // released by the main thread flipping index 0 to 1

mod.logEvent('marker', 'child-' + i, 'info', 'concurrent entry ' + i, {});
