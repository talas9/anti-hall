'use strict';
// settings.js — unified anti-hall settings store, ~/.anti-hall/settings.json.
// One JSON file, one section per registered feature (see settings-schema.js),
// so every setting has one home and one read/write API instead of a scatter
// of env vars + per-feature config files.
//
// PRECEDENCE (highest to lowest), matched exactly by get():
//   1. env override      — the schema entry's own ANTIHALL_* var, when set to
//                           a value the entry's type recognizes
//   2. settings.json      — ~/.anti-hall/settings.json[section][key]
//   3. plugin userConfig  — CLAUDE_PLUGIN_OPTION_<KEY> (hook processes) or a
//                           read-only fallback scan of a Claude settings file's
//                           pluginConfigs["anti-hall"].options (other
//                           processes never get the env var reliably)
//   4. legacy source      — the pre-settings.json config file this value used
//                           to live in (e.g. ~/.anti-hall/jev.json)
//   5. default            — the `dflt` argument, else the schema's own default
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

function coerceBoolToken(raw) {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).toLowerCase().trim();
  if (schema.TRUE_TOKENS.includes(v)) return true;
  if (schema.FALSE_TOKENS.includes(v)) return false;
  return undefined;
}

// coerceValue(entry, raw) -> typed value, or undefined when `raw` cannot be
// interpreted as this entry's type (falls through to the next source).
function coerceValue(entry, raw) {
  if (raw === undefined || raw === null || raw === '') return raw === '' && entry.type === 'string' ? '' : undefined;
  switch (entry.type) {
    case 'boolean':
      return coerceBoolToken(raw);
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      if (Number.isFinite(entry.min) && n < entry.min) return undefined;
      if (Number.isFinite(entry.max) && n > entry.max) return undefined;
      return n;
    }
    case 'enum':
      return (Array.isArray(entry.values) && entry.values.includes(String(raw))) ? String(raw) : undefined;
    case 'csv':
    case 'string':
      return String(raw);
    default:
      return raw;
  }
}

function readEnvOverride(entry, opts) {
  if (!entry.env) return undefined;
  const env = (opts && opts.env) || process.env;
  return coerceValue(entry, env[entry.env]);
}

// readPluginOption(entry, opts) -> value from CLAUDE_PLUGIN_OPTION_<KEY>
// (hooks get this env var) or, when absent, a read-only scan of
// ~/.claude/settings.json's pluginConfigs["anti-hall"].options[<key>] — the
// same value the native /config panel writes, for processes (statusline, the
// settings CLI) that are not guaranteed to inherit CLAUDE_PLUGIN_OPTION_*.
// This module NEVER writes to that file.
function readPluginOption(entry, opts) {
  if (!entry.pluginOption) return undefined;
  const env = (opts && opts.env) || process.env;
  const envName = 'CLAUDE_PLUGIN_OPTION_' + entry.pluginOption.toUpperCase();
  if (env[envName] !== undefined) return coerceValue(entry, env[envName]);
  try {
    const p = (opts && opts.claudeSettingsPath) || path.join(homeDir(opts), '.claude', 'settings.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const opt = raw && raw.pluginConfigs && raw.pluginConfigs['anti-hall'] && raw.pluginConfigs['anti-hall'].options;
    if (opt && Object.prototype.hasOwnProperty.call(opt, entry.pluginOption)) {
      return coerceValue(entry, opt[entry.pluginOption]);
    }
  } catch (_) { /* fail-open: no /config value reachable */ }
  return undefined;
}

function readLegacy(entry, opts) {
  if (!entry.legacy || !entry.legacy.file) return undefined;
  try {
    const p = path.join(homeDir(opts), '.anti-hall', entry.legacy.file);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    return coerceValue(entry, raw[entry.legacy.key]);
  } catch (_) {
    return undefined;
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
  const fileVal = store && store[section] && store[section][key];
  const coercedFile = coerceValue(entry, fileVal);
  if (coercedFile !== undefined) return coercedFile;

  const optionVal = readPluginOption(entry, opts);
  if (optionVal !== undefined) return optionVal;

  const legacyVal = readLegacy(entry, opts);
  if (legacyVal !== undefined) return legacyVal;

  return dflt !== undefined ? dflt : entry.default;
}

// validate(entry, value) -> {ok, error?, value?} — coerces + range/enum
// checks; used by set() so a bad write is rejected instead of stored.
function validate(entry, value) {
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

// set(section, key, value, opts?) -> {ok, error?}. Validates against the
// schema, then does a read-modify-write of the WHOLE file (preserving every
// other section/key untouched) with an atomic tmp+rename write.
function set(section, key, value, opts) {
  const entry = schema.findSetting(section, key);
  if (!entry) return { ok: false, error: 'unknown setting: ' + section + '.' + key };

  const v = validate(entry, value);
  if (!v.ok) return { ok: false, error: v.error };

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
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// reset(section, key, opts?) -> {ok, error?}. Removes the settings.json
// override for one key (so /config or legacy/default takes over again).
// A no-op success when the key was never overridden.
function reset(section, key, opts) {
  const entry = schema.findSetting(section, key);
  if (!entry) return { ok: false, error: 'unknown setting: ' + section + '.' + key };

  const store = load(opts);
  if (!store[section] || !Object.prototype.hasOwnProperty.call(store[section], key)) return { ok: true };

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
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// source(section, key, opts?) -> 'env' | 'file' | 'plugin-option' | 'legacy' |
// 'default' — which precedence tier the effective value actually came from.
// Used by `settings.js show` to render a Source column.
function source(section, key, opts) {
  const entry = schema.findSetting(section, key);
  if (!entry) return 'default';
  if (readEnvOverride(entry, opts) !== undefined) return 'env';
  const store = load(opts);
  const fileVal = store && store[section] && store[section][key];
  if (coerceValue(entry, fileVal) !== undefined) return 'file';
  if (readPluginOption(entry, opts) !== undefined) return 'plugin-option';
  if (readLegacy(entry, opts) !== undefined) return 'legacy';
  return 'default';
}

module.exports = { load, get, set, reset, source, path: settingsPath, validate };
