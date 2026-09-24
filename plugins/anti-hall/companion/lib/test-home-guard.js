'use strict';
// anti-hall :: test-home-guard — under `node --test`, refuse to run a
// state-mutating entry point (update.js runUpdate, doctor-repair runRepairs,
// migrations runMigrations) against the REAL user home. Repo rule: tests never
// touch the real home. Several leaks came through exactly this gap (a test
// calling runUpdate()/runRepairs() without an isolated HOME, so a stage fell
// back to os.homedir() and repaired the developer's real ~/.anti-hall).
//
// realHomeUnderTest(home) -> true when NODE_TEST_CONTEXT is set and `home`
// resolves to the passwd home (os.userInfo().homedir — immune to a HOME
// override, so an isolated HOME reads as "not real"). Outside `node --test`
// it is always false: production behaviour is unchanged.
const os = require('os');
const path = require('path');

function realHomeUnderTest(home, env) {
  const e = env || process.env;
  if (!(process.env.NODE_TEST_CONTEXT || e.NODE_TEST_CONTEXT) || !home) return false;
  let real = null;
  try { real = os.userInfo().homedir; } catch (_) { real = null; }
  if (!real) return false;
  try { return path.resolve(String(home)) === path.resolve(real); } catch (_) { return false; }
}

function refusalMessage(label, home) {
  return label + ' refused under node --test: home ' + JSON.stringify(String(home))
    + ' is the REAL user home — isolate HOME (and USERPROFILE) or pass an explicit fixture home';
}

module.exports = { realHomeUnderTest, refusalMessage };
