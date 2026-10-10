'use strict';
// Test support (NODE_OPTIONS=--require): pins Date.now to RECON_PIN_NOW in this process and every Node process it starts, so Node's
// own reconcile (and the subprocesses it spawns) stamp the same clock the engine's tick uses.
const n = Number(process.env.RECON_PIN_NOW);
if (Number.isFinite(n)) Date.now = () => n;
