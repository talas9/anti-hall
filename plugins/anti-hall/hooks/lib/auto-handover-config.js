// anti-hall :: auto-handover-config — resolved settings for the auto-handover
// trigger (hooks/auto-handover.js, hooks/auto-handover-pause-nag.js), backed
// by the shared hooks/lib/settings.js store.
//
// SECTION: <home>/.anti-hall/settings.json -> "autoHandover"
//   { "enabled": true, "pct": 85, "nag": true, "nagStepPct": 5, "nagQuietMin": 15 }
// Every key is OPTIONAL — an absent file, or an absent key within the
// section, means "default" (feature ON at 85%, milestone + pause nags ON).
// The user changes this by asking the agent, which runs
// scripts/auto-handover-config.js — never edits settings.json by hand.
//
// FIELDS
//   enabled     : feature on/off. No env equivalent (only the agent-driven
//                 CLI sets this) — except ANTIHALL_AUTO_HANDOVER_PCT=0, which
//                 disables it exactly like `enabled:false`.
//   pct         : the fire threshold, 1-99. Precedence: env
//                 ANTIHALL_AUTO_HANDOVER_PCT (valid 0-99) > settings.pct
//                 (valid 1-99) > default 85.
//   nag         : whether ANY post-fire reminder (milestone or natural-pause)
//                 repeats. false = the fire directive still fires once, but
//                 nothing reminds afterward.
//   nagStepPct  : after firing, nag again each time usage grows this many
//                 more points past the last nag (e.g. fire at 85, nag at 90,
//                 95, ...). Positive integer, default 5.
//   nagQuietMin : minimum minutes between natural-pause nags (Stop-time,
//                 only when no pending/in-progress tasks and no recently
//                 spawned subagents). Positive integer, default 15.
//
// VALIDATION: pct must be an integer in [1, 99]; nagStepPct/nagQuietMin must
// be positive integers — anything else falls back to the default rather than
// disabling or clamping silently. FAIL-OPEN: malformed/unreadable
// settings.json reads as all-defaults via settings.js — a broken config file
// never disables the always-on-by-default feature and never crashes a hook.
//
// Pure Node built-ins only.

'use strict';

const settings = require('./settings.js');

const SECTION = 'autoHandover';
const DEFAULT_PCT = 85;
const DEFAULT_NAG = true;
const DEFAULT_NAG_STEP_PCT = 5;
const DEFAULT_NAG_QUIET_MIN = 15;

function readConfig(home) {
  return settings.load({ home })[SECTION] || {};
}

// writeConfig(home, mutator) -> the persisted section object. Read-modify-
// write via settings.set() per key, atomic, never clobbers sibling sections.
function writeConfig(home, mutator) {
  const current = readConfig(home);
  const next = mutator(Object.assign({}, current)) || current;
  for (const k of Object.keys(next)) {
    settings.set(SECTION, k, next[k], { home });
  }
  return readConfig(home);
}

function isValidPct(n) {
  return Number.isInteger(n) && n >= 1 && n <= 99;
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

// resolveEffective({home, env}) -> { enabled, pct, nag, nagStepPct, nagQuietMin, source }
//   source: 'env' | 'file' | 'default' — where `pct` came from (tests only)
function resolveEffective(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const home = o.home;

  const cfg = readConfig(home);
  const nag = cfg.nag !== false; // default true
  const nagStepPct = isPositiveInt(cfg.nagStepPct) ? cfg.nagStepPct : DEFAULT_NAG_STEP_PCT;
  const nagQuietMin = isPositiveInt(cfg.nagQuietMin) ? cfg.nagQuietMin : DEFAULT_NAG_QUIET_MIN;

  const envRaw = env.ANTIHALL_AUTO_HANDOVER_PCT;
  if (envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== '') {
    const envN = parseInt(envRaw, 10);
    if (envN === 0) {
      return { enabled: false, pct: 0, nag: false, nagStepPct, nagQuietMin, source: 'env' };
    }
    if (isValidPct(envN)) {
      return { enabled: true, pct: envN, nag, nagStepPct, nagQuietMin, source: 'env' };
    }
    // invalid env value (not 0, not 1-99) -> fall through to file/default,
    // fail-open rather than disabling on a typo.
  }

  if (cfg.enabled === false) {
    return { enabled: false, pct: 0, nag: false, nagStepPct, nagQuietMin, source: 'file' };
  }

  const filePct = isValidPct(cfg.pct) ? cfg.pct : null;
  if (filePct !== null) {
    return { enabled: true, pct: filePct, nag, nagStepPct, nagQuietMin, source: 'file' };
  }
  return { enabled: true, pct: DEFAULT_PCT, nag, nagStepPct, nagQuietMin, source: 'default' };
}

module.exports = {
  readConfig,
  writeConfig,
  resolveEffective,
  isValidPct,
  isPositiveInt,
  DEFAULT_PCT,
  DEFAULT_NAG,
  DEFAULT_NAG_STEP_PCT,
  DEFAULT_NAG_QUIET_MIN,
  SECTION,
};
