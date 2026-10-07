#!/usr/bin/env node
// Parity of the built-in handover and Codex checks against their Node hooks. See b78lib.js.
//   node run-b78.js --hook codex-quota-detect --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
const lib = require('./b78lib.js');
const name = lib.arg('--hook');
if (!name) { console.error('usage: run-b78.js --hook <codex-quota-detect|codex-availability|codex-nudge|precompact-snapshot|handover-resume> --engine <bin> --hooks <dir>'); process.exit(64); }
const mod = require('./b78/' + name + '.js');
lib.runParity({ name, check: name, hookFile: name + '.js', scenarios: mod.scenarios(lib), engine: lib.arg('--engine', '../target/release/ah-engine'), hooks: lib.arg('--hooks') });
