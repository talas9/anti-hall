'use strict';
// reply-state-race-worker.js — one participant in the devswarm-reply-state.js
// concurrent-recordReply regression test
// (tests/companion/devswarm-reply-state.test.js). Run ONLY as a worker_thread
// (never required directly): waits on a shared Int32Array barrier so every
// participant's recordReply() call fires as close to simultaneously as
// possible — real OS-thread concurrency (libuv runs synchronous fs calls off
// the main thread per worker), which reproduces the original lost-update race
// (two writers both reading the pre-write state before either writes back)
// far more reliably than staggered async calls in a single thread ever could.
const { workerData } = require('worker_threads');

const { i, home, repoKey, sabBuffer, modulePath } = workerData;
// eslint-disable-next-line import/no-dynamic-require
const mod = require(modulePath);

const sab = new Int32Array(sabBuffer);
Atomics.wait(sab, 0, 0); // released by the main thread flipping index 0 to 1

mod.recordReply(repoKey, home, 'child-' + i, 1000 + i);
