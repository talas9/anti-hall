'use strict';
// settings.js — unified anti-hall settings store, ~/.anti-hall/settings.json.
// One JSON file, one section per registered feature (see settings-schema.js),
// so every setting has one home and one read/write API instead of a scatter
// of env vars + per-feature config files.
//
// PRECEDENCE (highest to lowest), matched exactly by get():
//   1. env override      — the schema entry's own ANTIHALL_* var, when set to
//                           a value the entry's type recognizes
//   2. settings.json      — ~/.anti-hall/settings.json[section][key] (a dotted
//                           key may also be written nested: see lookup())
//   3. plugin userConfig  — CLAUDE_PLUGIN_OPTION_<KEY> (hook processes) or a
//                           read-only fallback scan of a Claude settings file's
//                           pluginConfigs["anti-hall"].options (other
//                           processes never get the env var reliably)
//   4. legacy source      — the pre-settings.json config file this value used
//                           to live in (e.g. ~/.anti-hall/jev.json)
//   5. default            — the `dflt` argument, else the schema's own default
//
// LOCKED (safety) keys read through this SAME chain, no special-casing —
// only WRITING one (set()/reset()) is gated, by opts.confirmed (0.108.4
// revised design; see safetyWarning() below).
//
// FAIL-OPEN CONTRACT: load() never throws — a missing or corrupt
// settings.json reads back as {}. set() validates against the schema and
// writes atomically (tmp file + rename) so a crash mid-write can never
// corrupt the store; it never deletes another section's data.
// NO LEGACY DELETION: this module only ever READS legacy files as a fallback.
// Forward-migrating their values into settings.json (so `show`/`get` returns
// the same answer without depending on the legacy file) is a separate,
// idempotent step — see companion/lib/migrations.js migrateSettingsFromLegacy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('./settings-schema.js');

function homeDir(opts) {
  return (opts && opts.home) || os.homedir();
}

// homeFromEnv(env) -> the home dir an explicit env object implies (HOME, or
// USERPROFILE on Windows), falling back to os.homedir() ONLY when neither is
// present on the given env. This is the ONE place that derivation happens —
// every devswarm/env-parameter consumer routes through getWithEnv() below
// instead of re-deriving it, so a test that passes a fake env with an
// isolated HOME can never accidentally fall through to the real machine home.
function homeFromEnv(env) {
  const e = env || process.env;
  return (e && (e.HOME || e.USERPROFILE)) || os.homedir();
}

// getWithEnv(section, key, dflt, env) -> get(), but for callers that receive
// an explicit `env` PARAMETER (rather than reading `process.env` directly) —
// the pattern every DevSwarm resolver and a few others use for testability.
// Threads that same env object through AND derives `home` from it (never
// os.homedir() when the env carries a HOME), so settings.json/legacy lookups
// resolve against the SAME isolated home a test's fake env already implies.
function getWithEnv(section, key, dflt, env) {
  const e = env || process.env;
  return get(section, key, dflt, { env: e, home: homeFromEnv(e) });
}

// path(opts?) -> ~/.anti-hall/settings.json (home-injectable for tests).
function settingsPath(opts) {
  return path.join(homeDir(opts), '.anti-hall', 'settings.json');
}

// load(opts?) -> plain object, fail-open ({} on missing/unreadable/malformed).
function load(opts) {
  try {
    const raw = fs.readFileSync(settingsPath(opts), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// backupCorruptIfNeeded(opts) -> the backup path, or null when nothing needed
// backing up (file absent, or present and valid JSON). CRITICAL data-loss
// guard: load()'s fail-open {} is safe to READ, but set()/reset() must never
// silently read-modify-write a corrupt file — that would replace every other
// setting the file held with just the one key being written. When the file
// EXISTS but fails to parse (or is valid JSON of the wrong shape), it is
// renamed aside to `settings.json.corrupt-<ts>` (preserved byte-for-byte,
// NEVER deleted) before the write proceeds against a fresh {} store. A
// missing file (first run) is NOT corruption and is never backed up.
function backupCorruptIfNeeded(opts) {
  const file = settingsPath(opts);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null; // missing (or unreadable for another reason) -> nothing to back up
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return null; // valid -> not corrupt
  } catch (_) { /* fall through: back it up */ }
  try {
    const backupPath = file + '.corrupt-' + Date.now();
    fs.renameSync(file, backupPath);
    return backupPath;
  } catch (_) {
    return null; // best-effort; if the rename itself fails, proceed fail-open
  }
}

function coerceBoolToken(raw) {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).toLowerCase().trim();
  if (schema.TRUE_TOKENS.includes(v)) return true;
  if (schema.FALSE_TOKENS.includes(v)) return false;
  return undefined;
}

// coerceValue(entry, raw) -> typed value, or undefined when `raw` cannot be
// interpreted as this entry's type (falls through to the next source).
// TRIMMED + TYPE-CHECKED: a string `raw` is trimmed before any type-specific
// handling, so a blank/whitespace-only env or file value (e.g. `Number(' ')
// === 0`, which would otherwise silently turn a spend budget into "0" instead
// of falling through to the next tier) is treated as absent, not as a real
// zero/empty value. A non-string, non-number raw (object/array — a
// malformed settings.json shape) is rejected outright rather than coerced.
function coerceValue(entry, raw) {
  if (raw === undefined || raw === null) return undefined;
  // 'object' is the one type allowed to be a real object (file-only settings
  // like jev.prices — no env override, no CLI `set`; edited directly in
  // settings.json). Anything array-shaped or empty is rejected/falls through.
  if (entry.type === 'object') {
    return (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0) ? raw : undefined;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return undefined;
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '') return undefined;
  switch (entry.type) {
    case 'boolean':
      if (typeof trimmed === 'boolean') return trimmed;
      return coerceBoolToken(trimmed);
    case 'number': {
      if (typeof trimmed === 'boolean') return undefined;
      let n = Number(trimmed);
      if (!Number.isFinite(n)) return undefined;
      // exclusiveMin is a validity boundary (e.g. a spend budget "must be >
      // 0") — a value at/below it is REJECTED (falls through), never clamped
      // up to a made-up epsilon.
      if (Number.isFinite(entry.exclusiveMin) && n <= entry.exclusiveMin) return undefined;
      // min/max are RANGE bounds — CLAMPED, not rejected, matching every
      // legacy resolver's own parseEnvNum-style convention across this
      // codebase (e.g. devswarm-supervisor.js's parseEnvNum: `Math.max(min,
      // Math.min(max, v))`). An in-range-but-off value (env typo, a stale
      // settings.json) still resolves to something usable at this tier
      // instead of silently falling through to a lower one.
      if (Number.isFinite(entry.min) && n < entry.min) n = entry.min;
      if (Number.isFinite(entry.max) && n > entry.max) n = entry.max;
      return n;
    }
    case 'enum': {
      // Case-insensitive + trimmed, matching the legacy convention every
      // mode-string env var in this codebase already used (e.g.
      // devswarm-detect.js's ANTIHALL_DEVSWARM_SUPERVISOR: '  OFF '  ->
      // 'off'). `entry.values` are always declared lowercase in the schema,
      // so the match target is lowercased too.
      const v = String(trimmed).toLowerCase();
      return (Array.isArray(entry.values) && entry.values.includes(v)) ? v : undefined;
    }
    case 'csv':
    case 'string':
      return String(trimmed);
    default:
      return trimmed;
  }
}

function readEnvOverride(entry, opts) {
  if (!entry.env) return undefined;
  const env = (opts && opts.env) || process.env;
  return coerceValue(entry, env[entry.env]);
}

// pluginManifestDefault(entry, opts) -> plugin.json userConfig[key].default,
// or undefined when that userConfig entry declares no default (e.g. the Jev
// budget USD fields — every value there is real, never a manifest fallback).
function pluginManifestDefault(entry, opts) {
  if (!entry.pluginOption) return undefined;
  try {
    const p = (opts && opts.pluginJsonPath) || path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const uc = pj && pj.userConfig && pj.userConfig[entry.pluginOption];
    return uc ? uc.default : undefined;
  } catch (_) {
    return undefined;
  }
}

// readPluginOption(entry, opts) -> value from CLAUDE_PLUGIN_OPTION_<KEY>
// (hooks get this env var) or, when absent, a read-only scan of
// ~/.claude/settings.json's pluginConfigs["anti-hall"].options[<key>] — the
// same value the native /config panel writes, for processes (statusline, the
// settings CLI) that are not guaranteed to inherit CLAUDE_PLUGIN_OPTION_*.
// This module NEVER writes to that file.
//
// MASKING GUARD: Claude Code always exports CLAUDE_PLUGIN_OPTION_<KEY> once a
// userConfig entry exists — including when the person never touched /config
// and it is still sitting at its manifest default. Treating that value as a
// real override would permanently mask a lower tier (a jev.json enabled:true
// legacy value would become unreachable forever). So a value that equals the
// manifest's own declared default is treated as UNSET here — only a value
// that actually DIFFERS from the manifest default counts as a real /config
// choice.
function readPluginOption(entry, opts) {
  if (!entry.pluginOption) return undefined;
  const env = (opts && opts.env) || process.env;
  const envName = 'CLAUDE_PLUGIN_OPTION_' + entry.pluginOption.toUpperCase();
  const manifestDefault = pluginManifestDefault(entry, opts);
  const isManifestDefault = (raw) => manifestDefault !== undefined && String(raw) === String(manifestDefault);

  if (env[envName] !== undefined) {
    if (isManifestDefault(env[envName])) return undefined;
    return coerceValue(entry, env[envName]);
  }
  try {
    const p = (opts && opts.claudeSettingsPath) || path.join(homeDir(opts), '.claude', 'settings.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const opt = raw && raw.pluginConfigs && raw.pluginConfigs['anti-hall'] && raw.pluginConfigs['anti-hall'].options;
    if (opt && Object.prototype.hasOwnProperty.call(opt, entry.pluginOption)) {
      if (isManifestDefault(opt[entry.pluginOption])) return undefined;
      return coerceValue(entry, opt[entry.pluginOption]);
    }
  } catch (_) { /* fail-open: no /config value reachable */ }
  return undefined;
}

// settingsMigrationStamped(opts) -> true only when companion/lib/migrations.js
// has stamped migrateSettingsFromLegacy complete for the running plugin
// version. Lazy + guarded require (migrations.js itself only requires this
// module INSIDE function bodies, never at top level, so this is not a live
// cycle) — any failure fails to `false`, which is the SAFER answer here (see
// call site: false keeps legacy ranked above plugin-option, never the
// reverse).
function settingsMigrationStamped(opts) {
  try {
    const migrations = require('../../companion/lib/migrations.js');
    const home = homeDir(opts);
    const version = migrations.pluginVersion();
    const state = migrations.readMarkers(home);
    return migrations.isApplied(state, 'migrateSettingsFromLegacy', version);
  } catch (_) {
    return false;
  }
}

// lookup(obj, key) -> obj[key] (flat, e.g. "autoArchive.mode" as one key),
// else — for a dotted key — the NESTED path (obj.autoArchive.mode). Both
// shapes are accepted everywhere a value is read (settings.json sections and
// legacy files like jev.json {"budget": {"mode": ...}}); set() writes flat.
function lookup(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  if (typeof key !== 'string' || !key.includes('.')) return undefined;
  let cur = obj;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function readLegacy(entry, opts) {
  if (!entry.legacy || !entry.legacy.file) return undefined;
  try {
    const p = path.join(homeDir(opts), '.anti-hall', entry.legacy.file);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    return coerceValue(entry, lookup(raw, entry.legacy.key));
  } catch (_) {
    return undefined;
  }
}

// CONFIRMATION GATE (0.108.4, revised again). A `locked` schema entry is a
// safety guard switch. It reads through the SAME precedence chain as every
// other setting (env > settings.json > /config > legacy > default) — there is
// no special-cased ignore rule for it. What is gated is WRITING it in the
// RISKY direction: set() needs `opts.confirmed` (the CLI's `--confirmed`
// flag) only when the new value is the one that WEAKENS protection —
// `entry.safetyDirection` says which:
//   'off' — risky when the new value is `false` (turning the guard off);
//           turning it back ON needs no confirmation. Default for a locked
//           boolean entry when `safetyDirection` is omitted.
//   'on'  — risky when the new value is `true` (turning a bypass ON);
//           turning it off needs no confirmation.
//   'add' — risky when the new csv value ADDS at least one token not already
//           in the current effective value (widening an allow-list); a
//           removal-only or no-op change needs no confirmation.
// reset() REMOVES the settings.json override, so the key falls back to the
// next tier (/config, legacy, default). That fallback can itself be the risky
// direction — e.g. guards.stashGuard defaults to false, so resetting a
// human-armed `true` disarms it — so reset() computes the effective value
// AFTER removal and gates it through the same isRiskyChange() as set(); a
// reset that leaves the effective value unchanged or safer needs no
// confirmation. Without confirmation, set()/reset() write nothing and returns a short, factual,
// human-readable warning instead — built from the entry's own `safetyNote`
// (the plain-language CONSEQUENCE of the change) — so the caller can show it
// to a human and ask before re-running with --confirmed.
function guardNameFor(entry) {
  return String(entry.key).replace(/([A-Z])/g, '-$1').toLowerCase();
}
function csvTokens(v) {
  return String(v || '').split(/[,:]/).map((s) => s.trim()).filter(Boolean);
}
function addedTokens(newValue, currentValue) {
  const cur = new Set(csvTokens(currentValue));
  return csvTokens(newValue).filter((t) => !cur.has(t));
}
function isRiskyChange(entry, value, currentValue) {
  const dir = entry.safetyDirection || 'off';
  if (dir === 'on') return value === true;
  if (dir === 'add') return addedTokens(value, currentValue).length > 0;
  return value === false;
}
function safetyWarning(entry, value, currentValue) {
  const note = entry.safetyNote || 'this weakens a safety guard';
  const dir = entry.safetyDirection || 'off';
  if (dir === 'add') {
    const added = addedTokens(value, currentValue);
    const list = added.length ? added.join(', ') : String(value);
    return 'Adding ' + list + ' to edit-guard\'s allow list means ' + note + '. Ask the user to confirm, then re-run with --confirmed.';
  }
  const verb = dir === 'on' ? 'on' : 'off';
  return 'Turning ' + verb + ' ' + guardNameFor(entry) + ' means ' + note + '. Ask the user to confirm, then re-run with --confirmed.';
}

// enabled(section, key, opts?) -> false ONLY when an on/off switch resolves to
// exactly `false` (or a mode switch to 'off'); anything else, including any
// error, -> true. Hooks call this first thing and no-op when it is false, so a
// settings bug can never silently disable a guard.
function enabled(section, key, opts) {
  try {
    const v = get(section, key, undefined, opts);
    return v !== false && v !== 'off';
  } catch (_) {
    return true;
  }
}

// get(section, key, dflt?, opts?) -> the effective value for one setting,
// walking the precedence chain above. `dflt`, when passed, wins over the
// schema's own default (but nothing higher in the chain). Unknown
// section/key still resolves — it just skips straight to dflt/undefined,
// so callers migrating a brand-new setting never throw.
function get(section, key, dflt, opts) {
  const entry = schema.findSetting(section, key);
  if (!entry) return dflt;

  const envVal = readEnvOverride(entry, opts);
  if (envVal !== undefined) return envVal;

  const store = load(opts);
  const fileVal = store ? lookup(store[section], key) : undefined;
  const coercedFile = coerceValue(entry, fileVal);
  if (coercedFile !== undefined) return coercedFile;

  return resolveBelowFile(entry, dflt, opts);
}

// resolveBelowFile(entry, dflt, opts) -> the value the tiers BELOW
// settings.json resolve to (/config plugin-option, legacy, default). get()
// falls through to it; reset() uses it to learn the effective value a key
// will have once its settings.json override is removed.
function resolveBelowFile(entry, dflt, opts) {
  // Until the one-time forward-migration is stamped for this plugin version,
  // legacy config (e.g. jev.json) outranks a /config plugin-option value —
  // otherwise a pre-existing jev.json {enabled:true} would be masked forever
  // by /config's own (unset) manifest-default export. Once stamped, plugin-
  // option ranks above legacy as documented (its value has already been
  // forward-migrated into settings.json, which is checked above anyway).
  const legacyFirst = !!entry.legacy && !settingsMigrationStamped(opts);

  if (legacyFirst) {
    const legacyVal = readLegacy(entry, opts);
    if (legacyVal !== undefined) return legacyVal;
  }

  const optionVal = readPluginOption(entry, opts);
  if (optionVal !== undefined) return optionVal;

  if (!legacyFirst) {
    const legacyVal = readLegacy(entry, opts);
    if (legacyVal !== undefined) return legacyVal;
  }

  return dflt !== undefined ? dflt : entry.default;
}

// validate(entry, value) -> {ok, error?, value?} — coerces + range/enum
// checks; used by set() so a bad write is rejected instead of stored.
function validate(entry, value) {
  if (entry.type === 'object') {
    return { ok: false, error: 'this setting is file-only (edit ~/.anti-hall/settings.json directly); it cannot be changed via set()' };
  }
  if (entry.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    const b = coerceBoolToken(value);
    if (b === undefined) return { ok: false, error: 'expected a boolean (true/false/on/off/1/0), got ' + JSON.stringify(value) };
    return { ok: true, value: b };
  }
  if (entry.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: 'expected a number, got ' + JSON.stringify(value) };
    if (Number.isFinite(entry.min) && n < entry.min) return { ok: false, error: 'must be >= ' + entry.min };
    if (Number.isFinite(entry.max) && n > entry.max) return { ok: false, error: 'must be <= ' + entry.max };
    if (Number.isFinite(entry.exclusiveMin) && n <= entry.exclusiveMin) return { ok: false, error: 'must be > ' + entry.exclusiveMin };
    return { ok: true, value: n };
  }
  if (entry.type === 'enum') {
    const v = String(value);
    if (!entry.values.includes(v)) return { ok: false, error: 'must be one of: ' + entry.values.join(', ') };
    return { ok: true, value: v };
  }
  // csv / string: anything stringifiable is accepted.
  return { ok: true, value: String(value) };
}

// withSettingsLock(opts, fn) -> fn()'s result, or {ok:false, lockBusy:true,
// error} when another writer holds the lock past the wait budget. set() and
// reset() are read-modify-write of the WHOLE file: without a lock two
// concurrent writers (two sessions, a hook and the CLI) each read the old file
// and the second rename drops the first one's key. Same lock shape as
// hooks/repair-on-reload.js (atomic 'wx' create with our pid; a dead or stale
// holder is reclaimed); bounded wait, never throws.
const SETTINGS_LOCK_WAIT_MS = 2000;
const SETTINGS_LOCK_STALE_MS = 30000;
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function withSettingsLock(opts, fn) {
  const lock = settingsPath(opts) + '.lock';
  const deadline = Date.now() + SETTINGS_LOCK_WAIT_MS;
  let held = false;
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch (_) { /* surfaced by the write */ }
  while (!held) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      held = true;
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, error: 'settings lock failed: ' + ((e && e.message) || String(e)) };
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (_) { holder = null; }
    const stale = !holder || !pidAlive(holder.pid) || (Number.isFinite(holder.at) && Date.now() - holder.at > SETTINGS_LOCK_STALE_MS);
    if (stale) {
      try { fs.unlinkSync(lock); } catch (_) { /* another waiter reclaimed it */ }
      continue;
    }
    if (Date.now() >= deadline) {
      return { ok: false, lockBusy: true, error: 'settings.json is being written by another process (pid ' + holder.pid + '); retry' };
    }
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } catch (_) { /* busy-wait fallback */ }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch (_) { /* already gone */ } }
}

// set(section, key, value, opts?) -> {ok, error?}. Validates against the
// schema, then does a read-modify-write of the WHOLE file (preserving every
// other section/key untouched) with an atomic tmp+rename write. A `locked`
// (safety) key additionally needs `opts.confirmed` when the new value is the
// RISKY direction (see isRiskyChange/safetyWarning above) — without it
// nothing is written and the call returns {ok:false, needsConfirmation:true,
// warning}. The safe direction (re-arming a guard, narrowing an allow-list)
// never needs confirmation.
function set(section, key, value, opts) {
  const entry = schema.findSetting(section, key);
  if (!entry) return { ok: false, error: 'unknown setting: ' + section + '.' + key };

  const v = validate(entry, value);
  if (!v.ok) return { ok: false, error: v.error };

  if (entry.locked) {
    const currentValue = get(section, key, undefined, opts);
    if (isRiskyChange(entry, v.value, currentValue) && !(opts && opts.confirmed)) {
      return { ok: false, needsConfirmation: true, warning: safetyWarning(entry, v.value, currentValue) };
    }
  }

  return withSettingsLock(opts, () => {
  const backedUpCorruptTo = backupCorruptIfNeeded(opts);
  const store = load(opts);
  const next = Object.assign({}, store);
  next[section] = Object.assign({}, store[section]);
  next[section][key] = v.value;

  try {
    const file = settingsPath(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return backedUpCorruptTo ? { ok: true, backedUpCorruptTo } : { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  });
}

// reset(section, key, opts?) -> {ok, error?}. Removes the settings.json
// override for one key (so /config or legacy/default takes over again).
// A no-op success when the key was never overridden. For a `locked` (safety)
// key it needs `opts.confirmed` when the effective value AFTER removal is the
// RISKY direction relative to the current one (see isRiskyChange above) —
// without it nothing is written and it returns {ok:false,
// needsConfirmation:true, warning}. The check runs INSIDE withSettingsLock
// (P2 fix, rc-v0.108.4.2 review): it used to read+decide BEFORE acquiring the
// lock, so a concurrent writer (another session, or a hook) could change
// settings.json between the check and the delete below — a TOCTOU race where
// the confirmation decision was made against data that was already stale by
// the time the guard was actually disarmed.
function reset(section, key, opts) {
  const entry = schema.findSetting(section, key);
  if (!entry) return { ok: false, error: 'unknown setting: ' + section + '.' + key };

  return withSettingsLock(opts, () => {
  const backedUpCorruptTo = backupCorruptIfNeeded(opts);
  const store = load(opts);

  if (entry.locked && !(opts && opts.confirmed)) {
    if (store[section] && Object.prototype.hasOwnProperty.call(store[section], key)) {
      const currentValue = get(section, key, undefined, opts);
      const envVal = readEnvOverride(entry, opts);
      const afterValue = envVal !== undefined ? envVal : resolveBelowFile(entry, undefined, opts);
      const changes = entry.safetyDirection === 'add' || afterValue !== currentValue;
      if (changes && isRiskyChange(entry, afterValue, currentValue)) {
        return { ok: false, needsConfirmation: true, warning: safetyWarning(entry, afterValue, currentValue) };
      }
    }
  }

  if (!store[section] || !Object.prototype.hasOwnProperty.call(store[section], key)) {
    return backedUpCorruptTo ? { ok: true, backedUpCorruptTo } : { ok: true };
  }

  const next = Object.assign({}, store);
  next[section] = Object.assign({}, store[section]);
  delete next[section][key];
  if (Object.keys(next[section]).length === 0) delete next[section];

  try {
    const file = settingsPath(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return backedUpCorruptTo ? { ok: true, backedUpCorruptTo } : { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  });
}

// source(section, key, opts?) -> 'env' | 'file' | 'plugin-option' | 'legacy' |
// 'default' — which precedence tier the effective value actually came from.
// Used by `settings.js show` to render a Source column.
function source(section, key, opts) {
  const entry = schema.findSetting(section, key);
  if (!entry) return 'default';
  if (readEnvOverride(entry, opts) !== undefined) return 'env';
  const store = load(opts);
  const fileVal = store ? lookup(store[section], key) : undefined;
  if (coerceValue(entry, fileVal) !== undefined) return 'file';

  const legacyFirst = !!entry.legacy && !settingsMigrationStamped(opts);
  if (legacyFirst && readLegacy(entry, opts) !== undefined) return 'legacy';
  if (readPluginOption(entry, opts) !== undefined) return 'plugin-option';
  if (!legacyFirst && readLegacy(entry, opts) !== undefined) return 'legacy';
  return 'default';
}

module.exports = { load, get, getWithEnv, enabled, set, reset, source, path: settingsPath, validate, lookup, safetyWarning };
