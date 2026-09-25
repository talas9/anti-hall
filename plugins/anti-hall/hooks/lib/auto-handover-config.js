// anti-hall :: auto-handover-config — resolved settings for the auto-handover
// trigger (hooks/auto-handover.js, hooks/auto-handover-pause-nag.js), backed
// by the CANONICAL shared settings store (hooks/lib/settings.js +
// settings-schema.js) — section "autoHandover":
//   { enabled, pct (1-99), maxTokens (>=0, 0 = no ceiling), nag, nagStepPct, nagQuietMin,
//     gateNewWork, gateBudgetPct (1-50) }
// declared in settings-schema.js's SECTIONS, with `pct` wired to env
// ANTIHALL_AUTO_HANDOVER_PCT and `maxTokens` to ANTIHALL_AUTO_HANDOVER_MAX_TOKENS there. This file calls ONLY settings.js's public
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
// Post-handover new-work gate (hooks/lib/auto-handover-gate.js).
const DEFAULT_GATE_NEW_WORK = true;
const DEFAULT_GATE_BUDGET_PCT = 5;
// Absolute token ceiling, fired on whichever of pct / maxTokens comes first.
// DEFAULT IS OFF (0): the `pct` trigger (default 85, see DEFAULT_PCT above)
// is measured against this session's ACTUAL context window (see
// hooks/lib/context-pct.js), so it already fires at 85% of a 200K window, a
// 1M window, or whatever size a future model ships with — a fixed absolute
// token count would either fire far too early on a genuinely large window or
// require constant re-tuning as window sizes change. `maxTokens` stays
// available as an opt-in EXTRA ceiling for a user who wants an absolute
// floor regardless of window size (Chroma "Context Rot",
// https://www.trychroma.com/research/context-rot — 18 models degrade at
// every input-length increment tested, i.e. quality tracks absolute length,
// not the percentage of a larger window) — set via
// ANTIHALL_AUTO_HANDOVER_MAX_TOKENS or `scripts/auto-handover-config.js set
// maxTokens <n>`. See docs/KB-handover-research.md for the underlying
// research this feature was built from.
const DEFAULT_MAX_TOKENS = 0;

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
    maxTokens: settings.get(SECTION, 'maxTokens', DEFAULT_MAX_TOKENS, { home }),
    gateNewWork: settings.get(SECTION, 'gateNewWork', DEFAULT_GATE_NEW_WORK, { home }),
    gateBudgetPct: settings.get(SECTION, 'gateBudgetPct', DEFAULT_GATE_BUDGET_PCT, { home }),
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

function isValidMaxTokens(n) {
  return Number.isInteger(n) && n >= 0;
}

// overThreshold(result, cfg) -> 'pct' | 'tokens' | 'pct-unknown-window' | null.
// result is hooks/lib/context-pct.js's reading; cfg is resolveEffective()'s
// output. 'tokens' uses result.used, a REAL token count on every source (only
// the window size can be a guess), so it may fire the mandatory directive
// even when result.windowKnown === false; a pct crossing measured against an
// unknown (guessed 200K) window only reports 'pct-unknown-window' — callers
// give that the soft advisory, never the mandatory directive.
function overThreshold(result, cfg) {
  if (!result || !cfg || !cfg.enabled) return null;
  const byPct = Number.isFinite(result.pct) && result.pct >= cfg.pct;
  const byTokens = cfg.maxTokens > 0 && Number.isFinite(result.used) && result.used >= cfg.maxTokens;
  if (byPct && result.windowKnown !== false) return 'pct';
  if (byTokens) return 'tokens';
  if (byPct) return 'pct-unknown-window';
  return null;
}

// resolveEffective({home, env}) -> { enabled, pct, maxTokens, nag, nagStepPct, nagQuietMin,
//   gateNewWork, gateBudgetPct, source }
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
      return { enabled: false, pct: 0, maxTokens: 0, nag: false, nagStepPct: DEFAULT_NAG_STEP_PCT, nagQuietMin: DEFAULT_NAG_QUIET_MIN, gateNewWork: false, gateBudgetPct: DEFAULT_GATE_BUDGET_PCT, source: 'env' };
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
  const gateBudgetPct = settings.get(SECTION, 'gateBudgetPct', DEFAULT_GATE_BUDGET_PCT, { home, env });

  if (!enabled) {
    return { enabled: false, pct: 0, maxTokens: 0, nag: false, nagStepPct, nagQuietMin, gateNewWork: false, gateBudgetPct, source: 'file' };
  }

  const pct = settings.get(SECTION, 'pct', DEFAULT_PCT, { home, env });
  const maxTokens = Math.floor(settings.get(SECTION, 'maxTokens', DEFAULT_MAX_TOKENS, { home, env }));
  const gateNewWork = settings.get(SECTION, 'gateNewWork', DEFAULT_GATE_NEW_WORK, { home, env });

  let source = 'default';
  if (envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== '' && isValidPct(parseInt(envRaw, 10))) {
    source = 'env';
  } else {
    const raw = readConfig(home);
    if (Object.prototype.hasOwnProperty.call(raw, 'pct')) source = 'file';
  }

  return { enabled: true, pct, maxTokens, nag, nagStepPct, nagQuietMin, gateNewWork, gateBudgetPct, source };
}

module.exports = {
  readConfig,
  writeConfig,
  resolveEffective,
  isValidPct,
  isPositiveInt,
  isValidMaxTokens,
  overThreshold,
  DEFAULT_PCT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_NAG,
  DEFAULT_NAG_STEP_PCT,
  DEFAULT_NAG_QUIET_MIN,
  DEFAULT_GATE_NEW_WORK,
  DEFAULT_GATE_BUDGET_PCT,
  SECTION,
};
