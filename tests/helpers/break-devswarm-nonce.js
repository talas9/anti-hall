'use strict';
// break-devswarm-nonce.js — a NODE_OPTIONS=--require PRELOAD fixture that makes
// scripts/devswarm.js's deriveInstanceNonce() THROW, simulating the "instance
// nonce cannot be derived at all" case hooks/devswarm-child-gate.js's
// findRecentDropAttempt() fails CLOSED on (home/cwd unresolvable, or any other
// internal derivation error — deriveInstanceNonce itself is documented to
// "never throw to the caller" in production, so the ONLY realistic way to
// exercise this defensive branch in a test is to inject a fault here).
//
// Everything else on the module stays REAL (canonicalMeshId, isChildWorkspace,
// etc. — other call sites in the SAME hook, and elsewhere in the process,
// depend on them) — this poisons ONE export on the cached module object,
// mirroring break-devswarm-wake.js's Module._load interception pattern but
// WITHOUT making the whole module unloadable.
const Module = require('module');

const origLoad = Module._load;
let patched = false;
Module._load = function (request, parent, isMain) { // eslint-disable-line no-unused-vars
  const mod = origLoad.apply(this, arguments);
  if (!patched && typeof request === 'string'
      && /(^|[\\/])scripts[\\/]devswarm\.js$/.test(request)
      && mod && typeof mod.deriveInstanceNonce === 'function') {
    patched = true;
    mod.deriveInstanceNonce = function () {
      throw new Error('SIMULATED: deriveInstanceNonce cannot be derived (home/cwd unresolvable)');
    };
  }
  return mod;
};
