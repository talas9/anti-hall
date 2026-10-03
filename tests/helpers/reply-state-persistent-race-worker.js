'use strict';
// reply-state-persistent-race-worker.js — a REUSABLE participant for the
// devswarm-reply-state.js steal-CAS regression test's multi-round loop
// (tests/companion/devswarm-reply-state.test.js). Unlike
// reply-state-race-worker.js (one-shot: spawned once, does one recordReply
// call, exits), this worker is created ONCE per test and stays alive across
// every round, receiving each round's {repoKey, sabBuffer} over
// parentPort.postMessage instead of being re-spawned.
//
// WHY: the steal-CAS test needs MANY rounds to reliably surface a race that
// took 22 rounds under load to appear even once (see the "Raised, not
// lowered" comment on ROUNDS in the test file). Spawning two brand-new
// Worker() instances per round — each a real OS thread + fresh V8 isolate —
// for 40 rounds means 80 worker creations/teardowns in one test, which on
// its own measurably degrades OS scheduling for the LATER rounds (proven:
// failures showed up specifically as round-13+ near-total collapses with
// multi-second durations, i.e. the test harness's own churn was starving the
// very race it exists to catch, not a defect in the code under test — see
// devswarm-reply-state.js's own module header for what IS a real defect).
// Reusing two long-lived workers for all 40 rounds keeps total OS-thread
// creation at 2 for the whole test, isolating what's actually being
// measured (the steal-CAS algorithm) from worker_thread churn overhead.
const { workerData, parentPort } = require('worker_threads');

const { i, home, modulePath } = workerData;
// eslint-disable-next-line import/no-dynamic-require
const mod = require(modulePath);

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'round') return;
  const { repoKey, sabBuffer } = msg;
  const sab = new Int32Array(sabBuffer);
  Atomics.wait(sab, 0, 0); // released by the main thread flipping index 0 to 1 for THIS round
  mod.recordReply(repoKey, home, 'child-' + i, 1000 + i);
  parentPort.postMessage({ type: 'done' });
});
