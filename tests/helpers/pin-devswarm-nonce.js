'use strict';
// pin-devswarm-nonce.js — a NODE_OPTIONS=--require PRELOAD fixture that makes
// scripts/devswarm.js's deriveInstanceNonce() always return the FIXED value
// `FIXED-TEST-NONCE`, regardless of its {home,cwd} args.
//
// WHY: hooks/devswarm-child-gate.js's findRecentDropAttempt() authenticates a
// drop-attempt record against `deriveInstanceNonce({home,cwd})` — THIS
// process's own per-process/per-ancestor-session identity. In production that
// value is never null (documented "NEVER null and never throws to the
// caller"), so the only way a TEST can deterministically control what counts
// as "this process's own nonce" — to prove the twin-case match is genuinely
// nonce-based and id-INDEPENDENT (Wave 3 addendum item 10) — is to pin it to a
// known constant here and seed a drop-attempt row with that SAME constant as
// its `instanceNonce`.
//
// Mirrors break-devswarm-wake.js / break-devswarm-nonce.js's Module._load
// interception idiom, poisoning ONE export on the cached module object rather
// than making the whole module unloadable.
const Module = require('module');

const FIXED_TEST_NONCE = 'FIXED-TEST-NONCE';

const origLoad = Module._load;
let patched = false;
Module._load = function (request, parent, isMain) { // eslint-disable-line no-unused-vars
  const mod = origLoad.apply(this, arguments);
  if (!patched && typeof request === 'string'
      && /(^|[\\/])scripts[\\/]devswarm\.js$/.test(request)
      && mod && typeof mod.deriveInstanceNonce === 'function') {
    patched = true;
    mod.deriveInstanceNonce = function () {
      return FIXED_TEST_NONCE;
    };
  }
  return mod;
};

module.exports = { FIXED_TEST_NONCE };
