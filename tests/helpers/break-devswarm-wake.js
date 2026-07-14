'use strict';
// break-devswarm-wake.js — a NODE_OPTIONS=--require PRELOAD fixture that makes
// hooks/lib/devswarm-wake.js UNLOADABLE, simulating the lib being missing from a
// package or throwing on load.
//
// WHY: the three hooks that consume the wake lib (devswarm-child-role SessionStart,
// devswarm-child-gate + devswarm-parent-gate Stop) must FAIL OPEN — a hook that
// crashes at load degrades or wedges the user's session. A TOP-LEVEL require sits
// OUTSIDE each hook's own try/catch, so it would take the process down with an
// uncaught throw before any of that fail-open handling ran. Preloading this file
// proves the lazy+guarded require actually holds: the hooks still exit 0 and emit
// their pre-wake output instead of crashing.
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) { // eslint-disable-line no-unused-vars
  if (String(request).includes('devswarm-wake')) {
    throw new Error('SIMULATED: lib/devswarm-wake.js is unloadable (missing from packaging)');
  }
  return origLoad.apply(this, arguments);
};
