'use strict';
// credentials.js — the ONE place anti-hall resolves an API key.
//
// Resolution order (never logs, echoes or returns a key in any message):
//   1. The plugin option the user stored via /plugin config (anti-hall ->
//      jev_api_key / anthropic_api_key, sensitive: true). Claude Code exports
//      it to HOOK processes as CLAUDE_PLUGIN_OPTION_<KEY> (uppercased); the
//      detached/sync workers anti-hall spawns inherit that env. Statusline,
//      monitor and plain CLI/Bash-tool processes do NOT receive it.
//   2. ONLY behind a PER-KIND opt-in, each default false and HOME-SETTINGS
//      ONLY (schema `homeOnly`: ~/.anti-hall/settings.json — never env, never a
//      project .claude/settings.json, never /config):
//        jev       -> jev.allowLegacyKeyRead: AI_GATEWAY_API_KEY /
//                     TYPESAFE_API_KEY env vars, then the key file.
//        anthropic -> guards.allowAnthropicEnvKey: ANTHROPIC_API_KEY env.
//      The Codex port (no userConfig) enables them in that same file.
// With the opt-in off the plugin never reads a credential from the machine;
// it only reports that a legacy key EXISTS (presence check, value untouched)
// so doctor / jev-setup can tell the user how to migrate.

const fs = require('fs');
const path = require('path');
const MAX_KEY_FILE_BYTES = 4096;

const OPTION_ENV = {
  jev: 'CLAUDE_PLUGIN_OPTION_JEV_API_KEY',
  anthropic: 'CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY',
};
const OPTION_NAME = { jev: 'jev_api_key', anthropic: 'anthropic_api_key' };
const OPT_IN = { jev: ['jev', 'allowLegacyKeyRead'], anthropic: ['guards', 'allowAnthropicEnvKey'] };
const OPT_IN_SETTING = { jev: 'jev.allowLegacyKeyRead', anthropic: 'guards.allowAnthropicEnvKey' };

function legacyEnvName(kind, transport) {
  if (kind === 'anthropic') return 'ANTHROPIC_API_KEY';
  return transport === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY';
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// allowLegacyKeyRead(kind, opts) -> true only when that kind's opt-in resolves
// to exactly true (home settings file only). Any settings error -> false
// (fail-closed: never read a machine credential because settings broke).
function allowLegacyKeyRead(kind, opts) {
  try {
    const [sec, key] = OPT_IN[kind];
    return require('./settings.js').get(sec, key, false, opts) === true;
  } catch (_) {
    return false;
  }
}

// readKeyFile(keyPath, home) -> {key, rejected}. The key file is only read when
// ALL hold: the real path (symlinks resolved) is inside <home>/.config or
// <home>/.anti-hall, it is a regular file, <= 4096 bytes, and its trimmed
// content is ONE line with no whitespace. A missing file is a plain "no key"
// ({key:null, rejected:null}); a present-but-unacceptable file is
// {key:null, rejected:'<why>'} — the reason never contains file content.
function insideDir(real, dir) {
  const rel = path.relative(dir, real);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function readKeyFile(keyPath, home) {
  let real;
  try { real = fs.realpathSync(keyPath); } catch (_) { return { key: null, rejected: null }; }
  try {
    const roots = ['.config', '.anti-hall'].map((d) => {
      try { return fs.realpathSync(path.join(home, d)); } catch (_) { return path.join(home, d); }
    });
    if (!roots.some((r) => insideDir(real, r))) return { key: null, rejected: 'path is outside ~/.config and ~/.anti-hall' };
    const st = fs.lstatSync(real);
    if (!st.isFile()) return { key: null, rejected: 'not a regular file' };
    if (st.size > MAX_KEY_FILE_BYTES) return { key: null, rejected: 'larger than ' + MAX_KEY_FILE_BYTES + ' bytes' };
    const content = fs.readFileSync(real, 'utf8').trim();
    if (!content) return { key: null, rejected: null };
    if (/\s/.test(content)) return { key: null, rejected: 'content is not a single line without whitespace' };
    return { key: content, rejected: null };
  } catch (_) {
    return { key: null, rejected: 'unreadable' };
  }
}

// resolveKey(kind, {transport, keyFile, env, allowLegacy}) ->
//   {key: string|null, source: 'plugin-option'|'legacy-env'|'legacy-file'|null,
//    rejected?: why a present key file was refused (see readKeyFile)}
// kind: 'jev' | 'anthropic'. keyFile: absolute path (jev only), already
// expanded by the caller. allowLegacy: tests/callers may pass a boolean;
// default reads the settings key.
function resolveKey(kind, o) {
  const opts = o || {};
  const env = opts.env || process.env;
  const fromOption = nonEmpty(env[OPTION_ENV[kind]]);
  if (fromOption) return { key: fromOption, source: 'plugin-option' };

  const allow = typeof opts.allowLegacy === 'boolean' ? opts.allowLegacy : allowLegacyKeyRead(kind, opts);
  if (!allow) return { key: null, source: null };

  const fromEnv = nonEmpty(env[legacyEnvName(kind, opts.transport)]);
  if (fromEnv) return { key: fromEnv, source: 'legacy-env' };
  if (kind === 'jev' && opts.keyFile) {
    const f = readKeyFile(opts.keyFile, opts.home || require('../../companion/lib/test-home-guard.js').resolveHome(undefined, opts.env));
    if (f.key) return { key: f.key, source: 'legacy-file' };
    if (f.rejected) return { key: null, source: null, rejected: f.rejected };
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
    + OPTION_NAME[kind] + '), or enable ' + OPT_IN_SETTING[kind] + ' to keep using the existing key.';
}

// rejectedNotice(why) -> one line; names the reason, never file content.
function rejectedNotice(why) {
  return 'Jev key file rejected (' + why + '): it must be a regular file under ~/.config or ~/.anti-hall, at most 4096 bytes, one line with no whitespace.';
}

// backgroundNoKeyNotice() -> the one-line reason a NON-hook process (CLI,
// finding-dedup, jev-report, jev-setup) reports when it finds no Jev key.
// Claude Code hands CLAUDE_PLUGIN_OPTION_* to hook processes only.
function backgroundNoKeyNotice() {
  return 'no Jev key visible to this process: a key stored as a plugin option (/plugin config -> jev_api_key) is only visible to hooks; '
    + 'enable ' + OPT_IN_SETTING.jev + ' with a key file to make it available to background tools (CLI, finding-dedup, jev-report).';
}

// legacyNotices(opts) -> notice strings (opts.kinds limits which keys are
// checked). A kind whose opt-in is on, or with no legacy key present, yields
// nothing. Cannot know whether the plugin option is already set (CLI processes
// do not receive it) — the wording covers both cases.
function legacyNotices(o) {
  const opts = o || {};
  const kinds = Array.isArray(opts.kinds) ? opts.kinds : ['jev', 'anthropic'];
  const out = [];
  for (const k of kinds) {
    if (allowLegacyKeyRead(k, opts)) continue;
    if (legacyKeyPresent(k, opts)) out.push(migrationNotice(k));
  }
  return out;
}

// sessionNotice({home, env}) -> a one-line string or null: the ONE-TIME
// SessionStart notice that a legacy key is present but unused. Presence-only
// (never reads a value). Per-kind dedupe state lives in
// ~/.anti-hall/legacy-key-notice-state.json ({shown: {jev, anthropic}}); a kind
// is marked shown when its line is returned. Only for features the user turned
// on (jev.enabled; the Anthropic key also for jev.semanticJudge). Fail-open: any
// error -> null.
function sessionNotice(o) {
  try {
    const opts = o || {};
    const home = opts.home;
    const settings = require('./settings.js');
    const jevOn = settings.get('jev', 'enabled', false, { home, env: opts.env }) === true;
    const judgeOn = settings.get('jev', 'semanticJudge', false, { home, env: opts.env }) === true;
    const kinds = [];
    if (jevOn) kinds.push('jev');
    if (jevOn || judgeOn) kinds.push('anthropic');
    if (!kinds.length) return null;

    const stateFile = path.join(home, '.anti-hall', 'legacy-key-notice-state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (_) { state = {}; }
    const shown = (state.shown && typeof state.shown === 'object') ? state.shown : {};

    const jc = require('./jev-client.js');
    const cfg = jc.loadJevConfig();
    const pending = [];
    for (const k of kinds) {
      if (shown[k]) continue;
      if (allowLegacyKeyRead(k, { home, env: opts.env })) continue;
      if (legacyKeyPresent(k, { env: opts.env, transport: cfg.transport, keyFile: cfg.keyFile || jc.defaultKeyFilePath(cfg.transport) })) pending.push(k);
    }
    if (!pending.length) return null;

    const next = { shown: Object.assign({}, shown) };
    for (const k of pending) next.shown[k] = Date.now();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next) + '\n', 'utf8');
    fs.renameSync(tmp, stateFile);
    return 'anti-hall (shown once): ' + pending.map((k) => migrationNotice(k)).join(' ');
  } catch (_) {
    return null;
  }
}

module.exports = {
  OPTION_ENV, OPTION_NAME, OPT_IN_SETTING, readKeyFile, rejectedNotice,
  allowLegacyKeyRead, resolveKey, legacyKeyPresent, migrationNotice, backgroundNoKeyNotice, legacyNotices, sessionNotice,
};
