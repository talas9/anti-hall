'use strict';
// anti-hall :: lazy-node — load a Node built-in on first USE, not at require time.
//
// WHY: `require('crypto')` costs ~2 ms CPU at module load (measured: node -e 0 is
// ~17 ms, with crypto ~19.5 ms), and most hooks only hash/randomize on a rare path
// (a block, a dedupe write, a state file). Every hook is its own process, so an
// eager top-level require is paid on EVERY invocation. `const crypto =
// require('./lib/lazy-node.js').crypto` keeps every `crypto.createHash(...)` call
// site unchanged and defers the real require to the first property access.
//
// Only for member-style use (`crypto.createHash(...)`); a destructuring
// `const { createHash } = lazy.crypto` would trigger the load immediately.
// Pure Node built-ins, never throws beyond what the real module would.
function lazy(name) {
  let mod = null;
  return new Proxy({}, {
    get(_t, prop) {
      if (mod === null) mod = require(name);
      return mod[prop];
    },
    has(_t, prop) {
      if (mod === null) mod = require(name);
      return prop in mod;
    },
  });
}

module.exports = { lazy, crypto: lazy('crypto') };
