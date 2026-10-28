// check = "devswarm-version" (SessionStart). Probe 1 of the drift family: when the DevSwarm CLI version a background probe cached
// differs at any version component from the version anti-hall's integration was verified against, say so once per (installed, baseline)
// pair. A stale or absent cache asks the engine's refresh job for the probe and says nothing this session.
// Mirrors hooks/devswarm-version.js. Keys: session.toml (session.devswarm_*).
'use strict';
function decide() {
  if (spawn.osHome() === null) { ah.unable('devswarm-version:no_home', 'abandoned'); return 'allow'; } // no absolute HOME: no cache to read, nothing to say
  return sess.driftProbe({ setting: 'session.setting_devswarm', guard: 'session.devswarm_guard', cache: 'session.devswarm_cache',
    baseline: 'session.devswarm_baseline', what: 'session.devswarm_what', instead: 'session.devswarm_instead', keyed: false, exact: true, probe: 'devswarm' });
}
