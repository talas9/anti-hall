#!/usr/bin/env node
'use strict';
// anti-hall :: jev setup — activate/deactivate/configure the opt-in Jev
// classifier and manage its credential.
//
// USAGE
//   node plugins/anti-hall/scripts/jev-setup.js status
//   node plugins/anti-hall/scripts/jev-setup.js enable [--transport vercel|typesafe] [--fallback vercel|typesafe|none]
//   node plugins/anti-hall/scripts/jev-setup.js disable
//   node plugins/anti-hall/scripts/jev-setup.js set-key [--transport vercel|typesafe] [--role fallback]   (key read from STDIN)
//   node plugins/anti-hall/scripts/jev-setup.js bind-generic-key --vendor vercel|typesafe   (re-bind the legacy generic key / jev.keyFile)
//   node plugins/anti-hall/scripts/jev-setup.js test
//   node plugins/anti-hall/scripts/jev-setup.js mode <integration> on|shadow|off
//
// SECURITY CONTRACT (never relaxed):
//   - The key is read from STDIN ONLY. Never accepted as an argv value, never
//     echoed to stdout/stderr, never logged.
//   - `status`/`test` report key presence as yes/no only — the value itself
//     is never printed, by this script or by jev-client.js/jev-assist.js.
//   - The key file is written atomically (tmp + rename) with mode 0600,
//     achieved via a umask(0o077) scope so the temp file is created
//     already-private, then an explicit chmod as a second guarantee.
//   - `merge` operations on ~/.anti-hall/jev.json always read-modify-write —
//     they never clobber fields this script doesn't know about.
//
// This script only touches ~/.anti-hall/jev.json, the resolved key file, and
// (read-only) ~/.anti-hall/logs/jev-assist.ndjson. It never touches the real
// gateway except for the one `test` call, and never touches unrelated
// anti-hall state.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  jevDecide,
  defaultKeyFilePath,
  expandHome,
} = require('../hooks/lib/jev-client.js');

const VALID_TRANSPORTS = new Set(['vercel', 'typesafe']);
const VALID_MODES = new Set(['on', 'shadow', 'off']);
// Integrations with a wired jev-assist caller today. `status` always shows
// these even when jev.json says nothing about them yet (their effective
// default per lib/jev-assist.js: speculation/triage -> "on", everything
// else -> "shadow").
const KNOWN_INTEGRATIONS = [
  'speculation', 'triage', 'modelRouting', 'claimLedger', 'mergeGateHedge',
  'newRequest', 'outputVerifyGuard', 'gitGuardSelfCredit', 'parentGateQuestion',
  'tasklistTrivial', 'supervisorBlockerLabel', 'codexNudgeSubstantial',
  'findingDedup', 'postHandoverGate', 'dispatchTier',
  'devswarmOnBrief', 'devswarmExtraSanctioned', 'devswarmWaitKind', 'devswarmLoop', 'devswarmStepMap',
];
const LEGACY_ON_DEFAULT = new Set(['speculation', 'triage']);

function jevConfigPath() {
  return path.join(os.homedir(), '.anti-hall', 'jev.json');
}

function logPath() {
  return path.join(os.homedir(), '.anti-hall', 'logs', 'jev-assist.ndjson');
}

function readJevJson() {
  try {
    const raw = fs.readFileSync(jevConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// writeJevJsonMerged(mutator) — read-modify-write, atomic tmp+rename. The
// mutator receives a shallow copy of the CURRENT file (never clobbers fields
// it doesn't touch) and returns the object to persist.
function writeJevJsonMerged(mutator) {
  const dir = path.dirname(jevConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  const current = readJevJson();
  const next = mutator(Object.assign({}, current)) || current;
  const tmp = jevConfigPath() + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, jevConfigPath());
  return next;
}

// resolveFallback(cfg) -> 'none'|'vercel'|'typesafe'; a fallback equal to the
// primary (or anything unrecognised) is 'none', as in jev-client.js.
function resolveFallback(cfg, primary) {
  const fb = cfg.fallbackTransport;
  return ((fb === 'vercel' || fb === 'typesafe') && fb !== (primary || resolveTransport(cfg))) ? fb : 'none';
}

// effectiveCfg() — jev.json's raw fields, with enabled/transport/fallbackTransport/
// keyFile replaced by the EFFECTIVE value from the unified settings resolver
// (env > ~/.anti-hall/settings.json > /config option > legacy jev.json >
// default) — the very resolver jev-client.js uses, so `status` can never show a
// transport the hooks are not using. jev.json alone is only the legacy tier.
function effectiveCfg() {
  const cfg = readJevJson();
  try {
    const S = require('../hooks/lib/settings.js');
    for (const k of ['enabled', 'transport', 'fallbackTransport', 'keyFile']) {
      const v = S.get('jev', k, undefined);
      if (v !== undefined) cfg[k] = v;
    }
  } catch (_) { /* keep jev.json's own values */ }
  return cfg;
}

// setJev(key, value) -> true on success. The WRITE goes to the store that
// wins (settings.json) — writing jev.json would be masked by an existing
// settings.json value and silently change nothing for the hooks.
function setJev(key, value) {
  const r = require('../hooks/lib/settings.js').set('jev', key, value);
  if (!r.ok) fail(`could not set jev.${key}: ${r.error || r.warning || 'unknown error'}`);
  return r.ok;
}

function resolveTransport(cfg, override) {
  if (override && VALID_TRANSPORTS.has(override)) return override;
  return cfg.transport === 'typesafe' ? 'typesafe' : 'vercel';
}

// resolveKeyFilePath(cfg, transport) — mirrors jev-client.js's
// resolveCredential precedence: an explicit jev.json `keyFile` override wins
// (regardless of transport, matching the existing config contract); otherwise
// the transport's own default path.
function resolveKeyFilePath(cfg, transport) {
  // The explicit jev.keyFile is ambiguous (not named for a vendor), so it counts
  // only for the vendor the legacy generic key is bound to (the home-only
  // setting jev.genericKeyVendor); every other vendor uses its own default path.
  if (typeof cfg.keyFile === 'string' && cfg.keyFile.trim()
    && require('../hooks/lib/credentials.js').genericKeyVendor() === transport) {
    return expandHome(cfg.keyFile.trim());
  }
  return defaultKeyFilePath(transport);
}

// keyPresent(cfg, transport) — would the hooks find a key? Same resolution as
// jev-client.js (credentials.js): the plugin option env first, the legacy
// env/key file ONLY with jev.allowLegacyKeyRead on. NOTE: this CLI runs as a
// plain process, which Claude Code does NOT hand CLAUDE_PLUGIN_OPTION_* — a
// key stored via /plugin config is visible to the hooks but not here.
function keyPresent(cfg, transport) {
  return require('../hooks/lib/credentials.js').resolveKey('jev', {
    vendor: transport,
    keyFile: resolveKeyFilePath(cfg, transport),
  }).key !== null;
}

// isPrintable(s) — true iff every char is a printable, non-control character
// (rejects embedded NUL/newline/control bytes, allows normal API-key
// alphabets: letters, digits, -, _, ., etc.).
function isPrintable(s) {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// writeKeyFileAtomic(keyPath, contents) — mode 0600 via a scoped umask(0o077)
// (so the temp file is created already-private) plus an explicit chmod as a
// second guarantee, then atomic rename over any existing file.
function writeKeyFileAtomic(keyPath, contents) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const tmp = keyPath + '.tmp.' + process.pid;
  const prevUmask = process.umask(0o077);
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, keyPath);
  } finally {
    process.umask(prevUmask);
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function readLogRows() {
  const rows = [];
  for (const suffix of ['.1', '']) {
    try {
      const raw = fs.readFileSync(logPath() + suffix, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch (_) { /* skip corrupt line */ }
      }
    } catch (_) {
      // file doesn't exist yet — nothing to add
    }
  }
  return rows;
}

function callCountLast24h() {
  const cutoff = Date.now() - 86400000;
  let count = 0;
  for (const row of readLogRows()) {
    if (!row || typeof row !== 'object' || row.type === 'outcome' || !row.id) continue;
    const ts = row.ts ? Date.parse(row.ts) : NaN;
    if (Number.isFinite(ts) && ts >= cutoff) count++;
  }
  return count;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--transport') opts.transport = argv[++i];
    else if (a === '--fallback') opts.fallback = argv[++i];
    else if (a === '--role') opts.role = argv[++i];
    else if (a === '--vendor') opts.vendor = argv[++i];
    else if (a === '--days') opts.days = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

// --- verbs -----------------------------------------------------------------

async function cmdStatus() {
  const cfg = effectiveCfg();
  const enabled = cfg.enabled === true;
  const transport = resolveTransport(cfg);
  const present = keyPresent(cfg, transport);

  const integrationIds = Array.from(new Set([
    ...KNOWN_INTEGRATIONS,
    ...Object.keys((cfg.integrations && typeof cfg.integrations === 'object') ? cfg.integrations : {}),
  ]));
  const modes = {};
  for (const id of integrationIds) {
    // Same resolution the hooks use (settings.json > jev.json > default).
    let resolved;
    try { resolved = require('../hooks/lib/jev-assist.js').getMode(id, cfg, undefined, { assumeEnabled: true }); } catch (_) { resolved = undefined; }
    const configured = cfg.integrations && cfg.integrations[id];
    if (VALID_MODES.has(resolved)) modes[id] = resolved;
    else if (VALID_MODES.has(configured)) modes[id] = configured;
    else modes[id] = LEGACY_ON_DEFAULT.has(id) ? 'on' : 'shadow';
  }

  console.log(`enabled: ${enabled}`);
  console.log(`transport: ${transport}`);
  try {
    for (const d of require('../hooks/lib/jev-client.js').configDisagreements()) {
      const winner = d.source === 'file' ? '~/.anti-hall/settings.json' : (d.source === 'env' ? 'the environment' : 'the /config plugin option');
      console.log(`  warning: ~/.anti-hall/jev.json says ${d.key}=${JSON.stringify(d.legacy)} but ${winner} wins with ${JSON.stringify(d.effective)} (what the hooks use)`);
    }
  } catch (_) { /* report-only */ }
  console.log(`key present: ${present ? 'yes' : 'no'}`);
  if (cfg.keyFile || process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY) {
    console.log(`generic key (jev_api_key / jev.keyFile) bound to: ${require('../hooks/lib/credentials.js').genericKeyVendor()} (change only with bind-generic-key)`);
  }
  const fallback = resolveFallback(cfg, transport);
  console.log(`fallback transport: ${fallback}`);
  if (fallback !== 'none') {
    console.log(`fallback key present: ${keyPresent(cfg, fallback) ? 'yes' : 'no'}`);
    console.log('  note: with a fallback, text can be sent to the second vendor when the primary fails');
  }
  if (!present) console.log('  ' + require('../hooks/lib/credentials.js').backgroundNoKeyNotice());
  try {
    const cr = require('../hooks/lib/credentials.js');
    const rr = cr.resolveKey('jev', { vendor: transport, keyFile: resolveKeyFilePath(cfg, transport) });
    if (rr.rejected) console.log('  ' + cr.rejectedNotice(rr.rejected));
    if (rr.diagnostic) console.log('  ' + rr.diagnostic);
    if (fallback !== 'none') {
      const fr = cr.resolveKey('jev', { vendor: fallback, keyFile: resolveKeyFilePath(cfg, fallback) });
      if (fr.diagnostic) console.log('  fallback: ' + fr.diagnostic);
    }
  } catch (_) { /* best-effort */ }
  try {
    for (const n of require('../hooks/lib/credentials.js').legacyNotices({
      kinds: ['jev'], transport, keyFile: resolveKeyFilePath(cfg, transport),
    })) console.log('notice: ' + n);
  } catch (_) { /* notice is best-effort */ }
  console.log('integrations:');
  for (const id of integrationIds) {
    console.log(`  ${id}: ${modes[id]}`);
  }
  console.log(`calls (last 24h): ${callCountLast24h()}`);

  // Credit balance: only Vercel exposes one (TypeSafe's own API documents no
  // balance endpoint — /v1/credits, /v1/balance, /v1/usage, /v1/account and
  // /v1/me all 404). One line per configured vendor, labelled with the vendor,
  // so one vendor's balance is never shown as another's. Vercel's is served
  // from its own vendor-tagged 15-min cache; fail-open, never blocks `status`.
  for (const t of [transport, fallback].filter((x) => x !== 'none')) {
    if (t === 'typesafe') {
      console.log('credit balance (typesafe): not available (TypeSafe has no balance endpoint)');
      continue;
    }
    if (!enabled) continue;
    try {
      const { getCreditBalanceCached } = require('../hooks/lib/jev-client.js');
      const credit = await getCreditBalanceCached({});
      if (credit.ok) {
        console.log(`credit balance (vercel): $${credit.balanceUsd.toFixed(2)}${credit.cached ? ' (cached)' : ''}`);
      } else if (credit.reason === 'no-key') {
        console.log('credit balance (vercel): n/a (no vercel key visible to this process)');
      } else if (credit.reason !== 'unsupported-transport' && credit.reason !== 'disabled') {
        console.log(`credit balance (vercel): n/a (${credit.reason})`);
      }
    } catch (_) {
      // best-effort only -- status must never fail because of this
    }
  }
}

function cmdEnable(opts) {
  const transportOverride = opts.transport;
  if (transportOverride && !VALID_TRANSPORTS.has(transportOverride)) {
    fail(`enable: invalid --transport "${transportOverride}" (expected vercel|typesafe)`);
    return;
  }
  if (opts.fallback !== undefined && opts.fallback !== 'none' && !VALID_TRANSPORTS.has(opts.fallback)) {
    fail(`enable: invalid --fallback "${opts.fallback}" (expected vercel|typesafe|none)`);
    return;
  }
  if (!setJev('enabled', true)) return;
  if (transportOverride && !setJev('transport', transportOverride)) return;
  if (opts.fallback !== undefined && !setJev('fallbackTransport', opts.fallback)) return;
  // Never re-bind the generic key here: warn when the vendor just chosen has no
  // key of its own and the generic key / jev.keyFile belongs to the other one.
  for (const v of [transportOverride, opts.fallback]) warnUnboundVendor(v);
  const next = effectiveCfg();
  console.log(`jev enabled (transport: ${resolveTransport(next)}, fallback: ${resolveFallback(next, resolveTransport(next))})`);
  if (opts.fallback !== undefined && resolveFallback(next, resolveTransport(next)) === 'none' && opts.fallback !== 'none') {
    console.log('note: a fallback equal to the primary transport is treated as none');
  }
}

// warnUnboundVendor(v) — v was just chosen as primary/fallback. If no key bound
// to v is visible to this process and the legacy generic key / jev.keyFile is
// bound to the OTHER vendor, say so; the binding is never changed here.
function warnUnboundVendor(v) {
  if (!VALID_TRANSPORTS.has(v)) return;
  const cr = require('../hooks/lib/credentials.js');
  const bound = cr.genericKeyVendor();
  if (bound === v || keyPresent(effectiveCfg(), v)) return;
  console.log(`warning: no key for ${v} is visible to this process, and the stored generic key (jev_api_key / jev.keyFile) is bound to ${bound}, so it will NOT be sent to ${v}. `
    + `Enter a key for ${v} with \`set-key --transport ${v}\`, or set ${cr.VENDOR_OPTION_NAME[v]} in /plugin config. (To deliberately re-bind the generic key: bind-generic-key --vendor ${v}.)`);
}

function cmdBindGenericKey(opts) {
  if (!VALID_TRANSPORTS.has(opts.vendor)) {
    fail('bind-generic-key: --vendor vercel|typesafe is required');
    return;
  }
  const r = require('../hooks/lib/settings.js').set('jev', 'genericKeyVendor', opts.vendor, { confirmed: true });
  if (!r.ok) { fail(`could not set jev.genericKeyVendor: ${r.error || r.warning || 'unknown error'}`); return; }
  console.log(`jev.genericKeyVendor = ${opts.vendor}: the generic jev_api_key and jev.keyFile are now sent only to ${opts.vendor}, never to the other vendor (written to ~/.anti-hall/settings.json).`);
}

function cmdDisable() {
  if (!setJev('enabled', false)) return;
  console.log('jev disabled');
}

function cmdSetKey(opts) {
  const transportOverride = opts.transport;
  if (transportOverride && !VALID_TRANSPORTS.has(transportOverride)) {
    fail(`set-key: invalid --transport "${transportOverride}" (expected vercel|typesafe)`);
    return;
  }
  if (opts.role !== undefined && opts.role !== 'fallback') {
    fail(`set-key: invalid --role "${opts.role}" (expected fallback)`);
    return;
  }
  const cfg = effectiveCfg();
  const isFallback = opts.role === 'fallback';
  const transport = isFallback ? resolveFallback(cfg) : resolveTransport(cfg, transportOverride);
  if (isFallback && transport === 'none') {
    fail('set-key --role fallback: no fallback transport is configured — run `enable --fallback vercel|typesafe` first');
    return;
  }

  const raw = readStdin();
  const key = raw.trim();
  if (!key) {
    fail('set-key: no key received on stdin — pipe the key in, e.g. `printf \'%s\' "$KEY" | node jev-setup.js set-key`');
    return;
  }
  if (!isPrintable(key)) {
    fail('set-key: key contains non-printable characters — aborting');
    return;
  }

  const keyPath = resolveKeyFilePath(cfg, transport);
  writeKeyFileAtomic(keyPath, key + '\n');

  if (transportOverride && !isFallback && !setJev('transport', transportOverride)) return;

  console.log(`key saved for ${transport}`);
  if (!require('../hooks/lib/credentials.js').allowLegacyKeyRead('jev')) {
    console.log('note: the hooks only read this key file when jev.allowLegacyKeyRead is on (currently off). Preferred: store the key via /plugin config (anti-hall -> ' + 'jev_' + transport + '_api_key' + '), or enable the setting.');
  }
}

async function cmdTest() {
  const cfg = effectiveCfg();
  if (cfg.enabled !== true) {
    fail('test: jev is not enabled — run `enable` first');
    return;
  }
  const transport = resolveTransport(cfg);
  const fallback = resolveFallback(cfg, transport);
  const question = {
    type: 'noul',
    instructions: 'Is the sky typically blue on a clear day?',
    criteria: { true: 'yes', false: 'no' },
  };
  const state = 'On a clear day, the sky appears blue.';

  // Each configured transport is tested ON ITS OWN (only: pins one vendor, so a
  // working fallback can never mask a broken primary or the reverse).
  const targets = [{ label: 'primary', transport, only: fallback === 'none' ? undefined : 'primary' }];
  if (fallback !== 'none') targets.push({ label: 'fallback', transport: fallback, only: 'fallback' });

  for (const t of targets) {
    let r;
    try {
      r = await jevDecide({ question, state, only: t.only });
    } catch (_) {
      r = { ok: false, reason: 'error' };
    }
    const tag = targets.length > 1 ? `${t.label}, transport: ${t.transport}` : `transport: ${t.transport}`;
    if (r.ok) {
      console.log(`ok — latency ${r.ms}ms, confidence ${r.confidence.toFixed(2)} (${tag})`);
    } else {
      console.log(`failed: ${r.reason} (${tag})`);
      if (r.reason === 'no-key') {
        console.log(require('../hooks/lib/credentials.js').backgroundNoKeyNotice());
      } else if (typeof r.reason === 'string' && /^http-401|^http-403/.test(r.reason)) {
        console.log('the key was rejected — check the key is correct AND that the transport (vercel vs typesafe) matches where the key was issued');
      }
      process.exitCode = 1;
    }
  }
}

function cmdMode(opts) {
  const [integration, value] = opts._;
  if (!integration || !VALID_MODES.has(value)) {
    fail('mode: usage is `mode <integration> on|shadow|off`');
    return;
  }
  writeJevJsonMerged((cfg) => {
    cfg.integrations = Object.assign({}, cfg.integrations, { [integration]: value });
    return cfg;
  });
  // A 0.108.4+ integration id has its own settings key (jevIntegrations.<id>,
  // the canonical home as of 0.108.4) and is also written to
  // ~/.anti-hall/settings.json, which outranks jev.json — otherwise an
  // earlier settings value would silently mask this change.
  try {
    const schema = require('../hooks/lib/settings-schema.js');
    if (schema.findSetting('jevIntegrations', integration)) {
      const r = require('../hooks/lib/settings.js').set('jevIntegrations', integration, value);
      if (!r.ok) console.error('warning: settings.json not updated: ' + r.error);
    }
  } catch (_) { /* jev.json write above still applies */ }
  console.log(`${integration} mode set to ${value}`);
}

// --- shadow-review verbs ----------------------------------------------------
// Durable "time to review the Jev shadow numbers" reminder — see
// hooks/lib/jev-review.js for the full due-date/state contract.

function cmdReviewDue(opts) {
  const review = require('../hooks/lib/jev-review.js');
  const result = review.computeReviewDue();
  if (opts._.includes('--json')) {
    console.log(JSON.stringify(result.due));
    return;
  }
  if (!result.due.length) {
    console.log('jev review-due: nothing due (reviewAfterDays=' + result.reviewAfterDays +
      ', reviewMinDecisions=' + result.reviewMinDecisions + ')');
    return;
  }
  console.log('jev review-due:');
  for (const d of result.due) {
    console.log(`  ${d.id} (${d.days}d, ${d.decisions} decisions)`);
  }
}

function cmdReviewed(opts) {
  const [id] = opts._;
  if (!id) {
    fail('reviewed: usage is `reviewed <integration>`');
    return;
  }
  const review = require('../hooks/lib/jev-review.js');
  const r = review.markReviewed(id);
  console.log(`${id} marked reviewed` + (r.latencyMs != null ? ` (was due for ${Math.round(r.latencyMs / 3600000)}h)` : ''));
}

function cmdSnooze(opts) {
  const [id] = opts._;
  const days = Number(opts.days);
  if (!id || !Number.isFinite(days) || days <= 0) {
    fail('snooze: usage is `snooze <integration> --days N`');
    return;
  }
  const review = require('../hooks/lib/jev-review.js');
  const r = review.snoozeIntegration(id, undefined, days);
  if (!r.ok) {
    fail('snooze: ' + r.error);
    return;
  }
  console.log(`${id} snoozed until ${r.snoozedUntil}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const opts = parseArgs(argv.slice(1));

  switch (verb) {
    case 'status': return cmdStatus();
    case 'enable': return cmdEnable(opts);
    case 'disable': return cmdDisable();
    case 'set-key': return cmdSetKey(opts);
    case 'bind-generic-key': return cmdBindGenericKey(opts);
    case 'test': return cmdTest();
    case 'mode': return cmdMode(opts);
    case 'review-due': return cmdReviewDue(opts);
    case 'reviewed': return cmdReviewed(opts);
    case 'snooze': return cmdSnooze(opts);
    default:
      console.error('usage: jev-setup.js status|enable [--transport vercel|typesafe] [--fallback T]|disable|set-key [--transport vercel|typesafe] [--role fallback]|bind-generic-key --vendor V|test|mode <integration> on|shadow|off|review-due [--json]|reviewed <integration>|snooze <integration> --days N');
      process.exitCode = 1;
  }
}

module.exports = {
  readJevJson,
  writeJevJsonMerged,
  resolveTransport,
  resolveFallback,
  resolveKeyFilePath,
  keyPresent,
  isPrintable,
  writeKeyFileAtomic,
  callCountLast24h,
  jevConfigPath,
  logPath,
  cmdTest,
  cmdStatus,
};

if (require.main === module) {
  main();
}
