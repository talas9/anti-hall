#!/usr/bin/env node
// statusline.js — Dispatcher: routes stdin JSON to the right statusline renderer.
//
// Monorepo detection (checked at git toplevel, then cwd):
//   .gitmodules exists   => monorepo (git submodules)
//   .gsd/ dir exists     => monorepo (GSD project)
//   .planning/ dir exists => monorepo (planning state present)
// Otherwise => simple statusline.
//
// Pure Node. No bash, no grep/sed/cksum. Works on Windows, macOS, Linux.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
  } catch (e) {
    return cwd;
  }
}

function isMonorepo(dir) {
  if (fs.existsSync(path.join(dir, '.gitmodules'))) return true;
  if (fs.existsSync(path.join(dir, '.gsd')))        return true;
  if (fs.existsSync(path.join(dir, '.planning')))   return true;
  return false;
}

function main() {
  // Read all stdin first, then dispatch.
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      // Parse to get cwd; fall back gracefully if JSON is malformed.
      let cwd = process.cwd();
      try {
        const data = JSON.parse(input);
        cwd = data.workspace?.current_dir || data.cwd || cwd;
      } catch (e) { /* use process.cwd() */ }

      const toplevel = gitToplevel(cwd);
      const monorepo = isMonorepo(toplevel) || isMonorepo(cwd);

      const scriptDir = __dirname;
      const renderer = monorepo
        ? path.join(scriptDir, 'statusline-monorepo.js')
        : path.join(scriptDir, 'statusline-simple.js');

      // Require the renderer module and call its exported run function,
      // feeding it the already-buffered input via a fake stdin.
      // Each renderer exports a runWithInput(input) function (or falls back
      // to being require()'d and running if it detects non-main — we patch
      // stdin to replay the buffer instead).
      //
      // Implementation: inline-require and call runWithInput if exported;
      // otherwise replay by writing to a writable stream. The simplest
      // cross-platform approach: just require() the renderer — it sets up
      // its own stdin listener when require.main === module. Since we ARE
      // require()'ing it (not running it as main), we drive it explicitly
      // via its exported API. Both renderers export runWithInput().
      const mod = require(renderer);
      if (typeof mod.runWithInput === 'function') {
        mod.runWithInput(input);
      }
      // If export is missing (shouldn't happen), fail silently — statusline
      // must never crash Claude Code.
    } catch (e) {
      // Silent fail
    }
  });
}

main();
