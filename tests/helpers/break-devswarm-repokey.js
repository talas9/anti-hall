'use strict';
// break-devswarm-repokey.js — a NODE_OPTIONS=--require PRELOAD fixture that makes
// lib/devswarm-repokey.js UNLOADABLE, simulating the lib being missing from a
// package or throwing on load. Mirrors break-devswarm-wake.js's shape exactly.
//
// WHY: recovery.js requires devswarm-repokey.js at its OWN top level (D27-guarded,
// see recovery.js:52-59), and recovery.js is in turn required TOP-LEVEL by
// devswarm-supervisor.js:41 (the sweep loop) and scripts/devswarm.js:129 — neither
// of whose fail-open guarantees wrap their own top-level requires. A THROWING
// require here (a corrupt/deleted devswarm-repokey.js) would crash both consumers
// before fail-open ever engages if the guard were ever removed. Preloading this
// file proves the guarded require actually holds: requiring recovery.js still
// succeeds and notifyParentEscalation still runs without throwing.
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) { // eslint-disable-line no-unused-vars
  if (String(request).includes('devswarm-repokey')) {
    throw new Error('SIMULATED: lib/devswarm-repokey.js is unloadable (missing from packaging)');
  }
  return origLoad.apply(this, arguments);
};
