'use strict';
// Shared "devswarm.js as source text" reader. scripts/devswarm.js is the
// dispatcher plus (as code moves out of it) sibling modules under
// scripts/devswarm-lib/*.js; those files are ONE logical unit. Tests that
// assert on the SOURCE TEXT (pattern exists / pattern count / "only allowed
// in devswarm.js") must read this unit through the helpers below rather than
// fs.readFileSync-ing devswarm.js alone, so they keep working unchanged when
// code moves between the dispatcher and its modules.
//
// A test that is genuinely about the dispatcher file itself (its header
// banner, its `runArmed` verb switch) stays bound to devswarm.js directly.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PLUGIN_ROOT = path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall');

// sourceFiles(pluginRoot?): absolute paths — scripts/devswarm.js first, then
// every *.js directly under scripts/devswarm-lib/ (if it exists), sorted.
function sourceFiles(pluginRoot) {
  const scriptsDir = path.join(pluginRoot || DEFAULT_PLUGIN_ROOT, 'scripts');
  const out = [path.join(scriptsDir, 'devswarm.js')];
  const libDir = path.join(scriptsDir, 'devswarm-lib');
  let names = [];
  try { names = fs.readdirSync(libDir); } catch (_) { names = []; }
  names.filter((n) => n.endsWith('.js')).sort().forEach((n) => out.push(path.join(libDir, n)));
  return out;
}

// readEach(pluginRoot?): [{ file, text }] for every source file.
function readEach(pluginRoot) {
  return sourceFiles(pluginRoot).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

// readAll(pluginRoot?): the source files' text concatenated (newline-joined;
// with only devswarm.js present this is byte-identical to that file).
function readAll(pluginRoot) {
  return readEach(pluginRoot).map((e) => e.text).join('\n');
}

// logicalUnit(rel): maps a plugin-relative path ('scripts/devswarm-lib/x.js')
// onto the dispatcher's key ('scripts/devswarm.js') so file-keyed allowlists
// treat devswarm.js + devswarm-lib/* as one unit; any other path is unchanged.
function logicalUnit(rel) {
  return /^(?:plugins\/anti-hall\/)?scripts\/devswarm-lib\/[^/]+\.js$/.test(rel)
    ? rel.replace(/scripts\/devswarm-lib\/[^/]+\.js$/, 'scripts/devswarm.js')
    : rel;
}

module.exports = { sourceFiles, readEach, readAll, logicalUnit };
