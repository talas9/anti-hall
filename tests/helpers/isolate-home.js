'use strict';
// isolate-home.js — require this FIRST in any test file that runs code (in
// process, or via a spawned hook/script/devswarm.js/companion) that reads
// home-dir state (~/.anti-hall/*, ~/.claude/*) without the test passing its own
// HOME. It points HOME + USERPROFILE at a fresh empty temp dir for the whole
// test process, so the code under test (and every child it spawns with an
// inherited env) can never read — or write — the developer's real files
// (settings.json, usage/limit cache, codex availability, skip.json, ...).
//
// Tests that need a specific fixture home still pass their own HOME/ctx.home;
// that simply overrides this default. Idempotent per process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.ANTIHALL_TEST_HOME_ISOLATED) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-test-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ANTIHALL_TEST_HOME_ISOLATED = home;
  process.on('exit', () => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort, own temp dir */ }
  });
}
module.exports = { home: process.env.ANTIHALL_TEST_HOME_ISOLATED };
