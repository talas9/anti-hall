'use strict';
// enabled-install.js — which registered anti-hall install is the ENABLED one (#216).
//
// installed_plugins.json may register several `anti-hall@<marketplace>` keys at once (a stable copy and an engine-live
// copy, say); only the key settings.json's enabledPlugins marks true is the install the harness runs. Every site that
// reads the registry for "the" anti-hall install goes through here instead of pinning `anti-hall@anti-hall`.
// The generated stable launcher (hooks/lib/stable-launcher.js) is standalone by design and carries the same rule inline.
// Read only; never throws.

const fs = require('fs');
const path = require('path');

const KEY_PREFIX = 'anti-hall@';
const FALLBACK_KEY = 'anti-hall@anti-hall';

// registryOf(data) -> the key -> entries map of a parsed installed_plugins.json (v2 { plugins: {...} } or legacy flat).
function registryOf(data) {
  if (!data || typeof data !== 'object') return {};
  return (data.plugins && typeof data.plugins === 'object') ? data.plugins : data;
}

// entriesOf(reg, key) -> the install records of one key (array, single object or bare string normalised to a list).
function entriesOf(reg, key) {
  const e = reg ? reg[key] : undefined;
  if (Array.isArray(e)) return e;
  return e === undefined || e === null ? [] : [e];
}

// selectKeys(reg, enabledPlugins) -> { keys, choice }: the registered `anti-hall@*` keys enabledPlugins marks true
// (choice 'enabled'), else just the anti-hall@anti-hall pin (choice 'fallback').
function selectKeys(reg, enabledPlugins) {
  const on = enabledPlugins && typeof enabledPlugins === 'object' ? enabledPlugins : {};
  const keys = Object.keys(reg || {}).filter((k) => k.indexOf(KEY_PREFIX) === 0 && on[k] === true);
  return keys.length ? { keys, choice: 'enabled' } : { keys: [FALLBACK_KEY], choice: 'fallback' };
}

function readJson(p, F) {
  try { return JSON.parse((F || fs).readFileSync(p, 'utf8')); } catch (_) { return null; }
}

// load({ registryPath, settingsPath, fsi }) -> { reg, keys, choice }.
function load(o) {
  const x = o || {};
  const reg = registryOf(readJson(x.registryPath, x.fsi));
  const settings = readJson(x.settingsPath, x.fsi);
  const sel = selectKeys(reg, settings && settings.enabledPlugins);
  return { reg, keys: sel.keys, choice: sel.choice };
}

// forHome(home) -> load() for ~/.claude/plugins/installed_plugins.json + ~/.claude/settings.json.
function forHome(home, fsi) {
  return load({
    registryPath: path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    settingsPath: path.join(home, '.claude', 'settings.json'),
    fsi,
  });
}

// enabledEntries(sel) -> the install records of the selected keys, in key order.
function enabledEntries(sel) {
  const out = [];
  for (const k of sel.keys) for (const e of entriesOf(sel.reg, k)) out.push(e);
  return out;
}

// allEntries(reg) -> every record of every registered anti-hall@* key (enabled or not), for "keep everything registered" uses.
function allEntries(reg) {
  const out = [];
  for (const k of Object.keys(reg || {})) {
    if (k === FALLBACK_KEY || k.indexOf(KEY_PREFIX) === 0) for (const e of entriesOf(reg, k)) out.push(e);
  }
  return out;
}

module.exports = { KEY_PREFIX, FALLBACK_KEY, registryOf, entriesOf, selectKeys, load, forHome, enabledEntries, allEntries };
