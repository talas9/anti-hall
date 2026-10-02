#!/usr/bin/env node
// anti-hall :: Codex activation sentinel — advisory marker written by the
// anti-hall-activate skill. Writes ~/.anti-hall/codex-activated.json.
// Resetting or deleting it changes no real config.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(os.homedir(), '.anti-hall');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'codex-activated.json'),
  JSON.stringify({ activatedAt: new Date().toISOString(), scope: process.cwd() }, null, 2) + '\n'
);
