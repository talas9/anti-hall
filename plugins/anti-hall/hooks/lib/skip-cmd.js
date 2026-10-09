'use strict';
// skip-cmd.js — the shell-safe, absolute command a guard's block text hands the
// agent to record an explicit user-consented skip (~/.anti-hall/skip.json).
// A bare `node scripts/devswarm.js` only resolves from the plugin root; this
// resolves from this file, and quotes the path so a space, `$` or `'` is safe.
const path = require('node:path');

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function devswarmCli() {
  return path.join(__dirname, '..', '..', 'scripts', 'devswarm.js');
}

function skipCommand(key) {
  return 'node ' + shQuote(devswarmCli()) + ' skip ' + key;
}

module.exports = { shQuote, devswarmCli, skipCommand };
