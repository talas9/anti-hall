#!/usr/bin/env node
// anti-hall :: Codex limit-conserve status — prints isConserving() as JSON.
// Run by the anti-hall-context-conserve skill; read-only.
'use strict';

const path = require('path');

const root = process.env.ANTI_HALL_ROOT;
if (!root) {
  process.stderr.write('ANTI_HALL_ROOT is not set\n');
  process.exit(1);
}
const { isConserving } = require(path.join(root, 'hooks', 'limit-conserve.js'));
console.log(JSON.stringify(isConserving(), null, 2));
