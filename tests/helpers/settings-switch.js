'use strict';
// settings-switch.js — write a ~/.anti-hall/settings.json into a TEST home so a
// spawned hook resolves an on/off switch from it (0.108.4 "every feature is
// controllable from settings"). Only ever pass an isolated test home.

const fs = require('node:fs');
const path = require('node:path');

// writeSettings(home, obj) -> writes <home>/.anti-hall/settings.json = obj.
function writeSettings(home, obj) {
  const dir = path.join(home, '.anti-hall');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// switchOff(home, section, key) -> settings.json { [section]: { [key]: false } }.
function switchOff(home, section, key) {
  writeSettings(home, { [section]: { [key]: false } });
}

module.exports = { writeSettings, switchOff };
