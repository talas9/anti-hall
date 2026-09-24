// anti-hall :: auto-handover-config — resolved settings for the auto-handover
// trigger (hooks/auto-handover.js, hooks/auto-handover-pause-nag.js), backed
// by the CANONICAL shared settings store (hooks/lib/settings.js +
// settings-schema.js) — section "autoHandover":
//   { enabled, pct (1-99), nag, nagStepPct, nagQuietMin }
// declared in settings-schema.js's SECTIONS, with `pct` wired to env
// ANTIHALL_AUTO_HANDOVER_PCT there. This file calls ONLY settings.js's public
// surface (load/get/set/path) — it owns no file I/O or schema logic of its
// own.
//
// ONE PRECEDENCE WRINKLE settings.js's schema does NOT cover: "env
// ANTIHALL_AUTO_HANDOVER_PCT=0 disables the feature outright" — the schema's
// `pct` entry is `min:1,max:99`, so "0" fails that entry's own validation and
// settings.get() would just fall through to file/default, NOT read as
// "disable". That specific contract (part of this feature's ORIGINAL spec,
// unrelated to the generic settings precedence chain) is handled here,
// BEFORE consulting settings.get() at all — it does not reach into
// settings.js's internals to do it, so it stays compatible with any future
// settings.js revision.
//
// Every field is OPTIONAL — an absent settings.json, or an absent key within
// the section, means "default" (feature ON at 85%, milestone + pause nags
// ON). The user changes this by asking the agent, which runs
// scripts/auto-handover-config.js — never edits settings.json by hand.
//
// FAIL-OPEN: settings.get() itself is fail-open (a malformed settings.json
// reads as all-defaults) — nothing here needs its own try/catch around that.
//
// Pure Node built-ins only (settings.js is pure Node too).

'use strict';

const settings = require('./settings.js');

const SECTION = 'autoHandover';
const DEFAULT_PCT = 85;
const DEFAULT_NAG = true;
const DEFAULT_NAG_STEP_PCT = 5;
const DEFAULT_NAG_QUIET_MIN = 15;

// readConfig(home) -> the RAW settings.json section (NOT the resolved
// values) — {} when nothing has ever been written. Used by the CLI's `get`
// command and by tests that assert nothing was written on a rejected input.
function readConfig(home) {
  const all = settings.load({ home });
  return (all && all[SECTION] && typeof all[SECTION] === 'object') ? all[SECTION] : {};
}

// writeConfig(home, mutator) -> the resolved section AFTER the write.
// mutator receives the CURRENT EFFECTIVE values (not just the raw file —
// so e.g. toggling `nag` doesn't require the caller to already know `pct`)
// and returns the object to persist; only keys that actually changed are
// written (settings.set() one key at a time, per its own API).
function writeConfig(home, mutator) {
  const current = {
    enabled: settings.get(SECTION, 'enabled', true, { home }),
    pct: settings.get(SECTION, 'pct', DEFAULT_PCT, { home }),
    nag: settings.get(SECTION, 'nag', DEFAULT_NAG, { home }),
    nagStepPct: settings.get(SECTION, 'nagStepPct', DEFAULT_NAG_STEP_PCT, { home }),
    nagQuietMin: settings.get(SECTION, 'nagQuietMin', DEFAULT_NAG_QUIET_MIN, { home }),
  };
  const next = mutator(Object.assign({}, current)) || current;
  for (const key of Object.keys(next)) {
    if (next[key] !== current[key]) settings.set(SECTION, key, next[key], { home });
  }
  return next;
}

function isValidPct(n) {
  return Number.isInteger(n) && n >= 1 && n <= 99;
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

// resolveEffective({home, env}) -> { enabled, pct, nag, nagStepPct, nagQuietMin, source }
//   source: 'env' | 'file' | 'default' — where `pct` came from (tests only;
//   a plugin-option/legacy hit from settings.js also reports as 'file' here,
//   since this feature has neither wired).
function resolveEffective(opts) {
  const o = opts || {};
  const home = o.home;
  const env = o.env || process.env;

  // The ONE precedence wrinkle settings.js's schema can't express (see file
  // header): env="0" disables outright, checked BEFORE settings.get().
  const envRaw = env.ANTIHALL_AUTO_HANDOVER_PCT;
  if (envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== '') {
    const envN = parseInt(envRaw, 10);
    if (envN === 0) {
      return { enabled: false, pct: 0, nag: false, nagStepPct: DEFAULT_NAG_STEP_PCT, nagQuietMin: DEFAULT_NAG_QUIET_MIN, source: 'env' };
    }
    // A valid 1-99 env value flows through settings.get() below normally
    // (the schema's own `pct` entry declares this same env var), so no
    // special-case is needed for that case — it naturally resolves to
    // source:'env' there.
  }

  const enabled = settings.get(SECTION, 'enabled', true, { home, env });
  const nag = settings.get(SECTION, 'nag', DEFAULT_NAG, { home, env });
  const nagStepPct = settings.get(SECTION, 'nagStepPct', DEFAULT_NAG_STEP_PCT, { home, env });
  const nagQuietMin = settings.get(SECTION, 'nagQuietMin', DEFAULT_NAG_QUIET_MIN, { home, env });

  if (!enabled) {
    return { enabled: false, pct: 0, nag: false, nagStepPct, nagQuietMin, source: 'file' };
  }

  const pct = settings.get(SECTION, 'pct', DEFAULT_PCT, { home, env });

  let source = 'default';
  if (envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== '' && isValidPct(parseInt(envRaw, 10))) {
    source = 'env';
  } else {
    const raw = readConfig(home);
    if (Object.prototype.hasOwnProperty.call(raw, 'pct')) source = 'file';
  }

  return { enabled: true, pct, nag, nagStepPct, nagQuietMin, source };
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
