#!/usr/bin/env node
// Node side of the scrub parity check: reads JSON strings, one per line, prints each one's scrubSecrets() as a JSON string
// per line (the authority: hooks/lib/secret-scrub.js). Usage: node jev-node-scrub.js <hooks-dir>
const path = require('path');
const { scrubSecrets } = require(path.join(path.resolve(process.argv[2]), 'lib', 'secret-scrub.js'));
const lines = require('fs').readFileSync(0, 'utf8').split('\n').filter((l) => l.trim());
process.stdout.write(lines.map((l) => JSON.stringify(scrubSecrets(JSON.parse(l)))).join('\n') + '\n');
