'use strict';
// credentials.js — the ONE place anti-hall resolves an API key.
//
// Resolution order (never logs, echoes or returns a key in any message):
//   1. The plugin option the user stored via /plugin config (anti-hall ->
//      jev_api_key / anthropic_api_key, sensitive: true). Claude Code exports
//      it to HOOK processes as CLAUDE_PLUGIN_OPTION_<KEY> (uppercased); the
//      detached/sync workers anti-hall spawns inherit that env. Statusline,
//      monitor and plain CLI/Bash-tool processes do NOT receive it.
//   2. ONLY when the settings key jev.allowLegacyKeyRead is true (default
//      false): the legacy machine sources — AI_GATEWAY_API_KEY /
//      TYPESAFE_API_KEY / ANTHROPIC_API_KEY env vars, then the key file.
//      This is the path the Codex port (no userConfig) enables via
//      ~/.anti-hall/settings.json.
// With the opt-in off the plugin never reads a credential from the machine;
// it only reports that a legacy key EXISTS (presence check, value untouched)
// so doctor / jev-setup can tell the user how to migrate.

const fs = require('fs');

const OPTION_ENV = {
  jev: 'CLAUDE_PLUGIN_OPTION_JEV_API_KEY',
  anthropic: 'CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY',
};
const OPTION_NAME = { jev: 'jev_api_key', anthropic: 'anthropic_api_key' };
const OPT_IN_SETTING = 'jev.allowLegacyKeyRead';

function legacyEnvName(kind, transport) {
  if (kind === 'anthropic') return 'ANTHROPIC_API_KEY';
  return transport === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY';
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// allowLegacyKeyRead() -> true only when the opt-in resolves to exactly true.
// Any settings error -> false (fail-closed: never read a machine credential
// because settings broke).
function allowLegacyKeyRead(opts) {
  try {
    return require('./settings.js').get('jev', 'allowLegacyKeyRead', false, opts) === true;
  } catch (_) {
    return false;
  }
}

// resolveKey(kind, {transport, keyFile, env, allowLegacy}) ->
//   {key: string|null, source: 'plugin-option'|'legacy-env'|'legacy-file'|null}
// kind: 'jev' | 'anthropic'. keyFile: absolute path (jev only), already
// expanded by the caller. allowLegacy: tests/callers may pass a boolean;
// default reads the settings key.
function resolveKey(kind, o) {
  const opts = o || {};
  const env = opts.env || process.env;
  const fromOption = nonEmpty(env[OPTION_ENV[kind]]);
  if (fromOption) return { key: fromOption, source: 'plugin-option' };

  const allow = typeof opts.allowLegacy === 'boolean' ? opts.allowLegacy : allowLegacyKeyRead(opts);
  if (!allow) return { key: null, source: null };

  const fromEnv = nonEmpty(env[legacyEnvName(kind, opts.transport)]);
  if (fromEnv) return { key: fromEnv, source: 'legacy-env' };
  if (kind === 'jev' && opts.keyFile) {
    try {
      const fromFile = nonEmpty(fs.readFileSync(opts.keyFile, 'utf8'));
      if (fromFile) return { key: fromFile, source: 'legacy-file' };
    } catch (_) { /* absent/unreadable -> no key */ }
  }
  return { key: null, source: null };
}

// legacyKeyPresent(kind, {transport, keyFile, env}) -> boolean. Presence only:
// an env var that is non-empty, or a regular non-empty file. The value is
// never read into a returned/logged string.
function legacyKeyPresent(kind, o) {
  const opts = o || {};
  const env = opts.env || process.env;
  const v = env[legacyEnvName(kind, opts.transport)];
  if (typeof v === 'string' && v.length > 0) return true;
  if (kind === 'jev' && opts.keyFile) {
    try {
      const st = fs.statSync(opts.keyFile);
      return st.isFile() && st.size > 0;
    } catch (_) { return false; }
  }
  return false;
}

// migrationNotice(kind) -> the one-line user notice (no key material).
function migrationNotice(kind) {
  return 'a legacy ' + (kind === 'anthropic' ? 'ANTHROPIC_API_KEY env var' : 'Jev key file/env var')
    + ' exists but anti-hall no longer reads credentials from this machine: re-enter your key via /plugin config (anti-hall -> '
    + OPTION_NAME[kind] + '), or enable ' + OPT_IN_SETTING + ' to keep using the existing key.';
}

// legacyNotices(opts) -> notice strings (opts.kinds limits which keys are checked) to show (doctor / jev-setup status).
// Empty when the opt-in is on or no legacy key exists. Cannot know whether the
// plugin option is already set (CLI processes do not receive it) — the notice
// wording covers both cases.
function legacyNotices(o) {
  const opts = o || {};
  if (allowLegacyKeyRead(opts)) return [];
  const kinds = Array.isArray(opts.kinds) ? opts.kinds : ['jev', 'anthropic'];
  const out = [];
  for (const k of kinds) if (legacyKeyPresent(k, opts)) out.push(migrationNotice(k));
  return out;
}

module.exports = {
  OPTION_ENV, OPTION_NAME, OPT_IN_SETTING,
  allowLegacyKeyRead, resolveKey, legacyKeyPresent, migrationNotice, legacyNotices,
};
