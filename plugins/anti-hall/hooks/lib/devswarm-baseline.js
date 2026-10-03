'use strict';
// anti-hall :: devswarm-baseline — the SINGLE authoritative source for the
// DevSwarm CLI version anti-hall's integration (command-guard.js's hardcoded
// DevSwarm CLI verb literals + docs/KB-devswarm-hivecontrol.md) is verified
// against.
//
// Consumed by:
//   - hooks/devswarm-version.js         (SessionStart advisory)
//   - hooks/devswarm-version-refresh.js (background probe; writes cache.baseline)
//   - companion/lib/doctor-devswarm.js  (`/anti-hall:doctor` surface)
//
// Previously each of the first two files defined its own copy of BASELINE,
// kept in sync only by a comment, while doctor-devswarm.js compared against
// whatever the refresh script had last written into the cache
// (`cache.baseline`) instead of a live constant. That let the three drift
// independently. Now all three require this one module, so the baseline
// literally cannot diverge between them.
//
// Bump this deliberately when the KB is re-verified against a newer DevSwarm
// release.
const DEVSWARM_BASELINE = '2.5.1';

module.exports = { DEVSWARM_BASELINE };
