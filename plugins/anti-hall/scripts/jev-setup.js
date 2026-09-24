#!/usr/bin/env node
'use strict';
// anti-hall :: jev setup — activate/deactivate/configure the opt-in Jev
// classifier and manage its credential.
//
// USAGE
//   node plugins/anti-hall/scripts/jev-setup.js status
//   node plugins/anti-hall/scripts/jev-setup.js enable [--transport vercel|typesafe]
//   node plugins/anti-hall/scripts/jev-setup.js disable
//   node plugins/anti-hall/scripts/jev-setup.js set-key [--transport vercel|typesafe]   (key read from STDIN)
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

function resolveTransport(cfg, override) {
  if (override && VALID_TRANSPORTS.has(override)) return override;
  return cfg.transport === 'typesafe' ? 'typesafe' : 'vercel';
}

// resolveKeyFilePath(cfg, transport) — mirrors jev-client.js's
// resolveCredential precedence: an explicit jev.json `keyFile` override wins
// (regardless of transport, matching the existing config contract); otherwise
// the transport's own default path.
function resolveKeyFilePath(cfg, transport) {
  if (typeof cfg.keyFile === 'string' && cfg.keyFile.trim()) {
    return expandHome(cfg.keyFile.trim());
  }
  return defaultKeyFilePath(transport);
}

function envVarForTransport(transport) {
  return transport === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY';
}

function keyPresentOnDisk(keyPath) {
  try {
    const contents = fs.readFileSync(keyPath, 'utf8').trim();
    return contents.length > 0;
  } catch (_) {
    return false;
  }
}

function keyPresent(cfg, transport) {
  const envVal = process.env[envVarForTransport(transport)];
  if (typeof envVal === 'string' && envVal.trim()) return true;
  return keyPresentOnDisk(resolveKeyFilePath(cfg, transport));
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
  const cfg = readJevJson();
  const enabled = cfg.enabled === true;
  const transport = resolveTransport(cfg);
  const present = keyPresent(cfg, transport);

  const integrationIds = Array.from(new Set([
    ...KNOWN_INTEGRATIONS,
    ...Object.keys((cfg.integrations && typeof cfg.integrations === 'object') ? cfg.integrations : {}),
  ]));
  const modes = {};
  for (const id of integrationIds) {
    const configured = cfg.integrations && cfg.integrations[id];
    if (VALID_MODES.has(configured)) modes[id] = configured;
    else modes[id] = LEGACY_ON_DEFAULT.has(id) ? 'on' : 'shadow';
  }

  console.log(`enabled: ${enabled}`);
  console.log(`transport: ${transport}`);
  console.log(`key present: ${present ? 'yes' : 'no'}`);
  console.log('integrations:');
  for (const id of integrationIds) {
    console.log(`  ${id}: ${modes[id]}`);
  }
  console.log(`calls (last 24h): ${callCountLast24h()}`);

  // Credit balance -- vercel transport only (TypeSafe's own API documents no
  // equivalent endpoint, see jev-client.js's getCreditBalance doc comment),
  // served from its own 15-min cache. Fail-open: never blocks `status`.
  try {
    const { getCreditBalanceCached } = require('../hooks/lib/jev-client.js');
    const credit = await getCreditBalanceCached({});
    if (credit.ok) {
      console.log(`credit balance: $${credit.balanceUsd.toFixed(2)}${credit.cached ? ' (cached)' : ''}`);
    } else if (credit.reason !== 'unsupported-transport' && credit.reason !== 'disabled' && credit.reason !== 'no-key') {
      console.log(`credit balance: n/a (${credit.reason})`);
    }
  } catch (_) {
    // best-effort only -- status must never fail because of this
  }
}

function cmdEnable(opts) {
  const transportOverride = opts.transport;
  if (transportOverride && !VALID_TRANSPORTS.has(transportOverride)) {
    fail(`enable: invalid --transport "${transportOverride}" (expected vercel|typesafe)`);
    return;
  }
  const next = writeJevJsonMerged((cfg) => {
    cfg.enabled = true;
    cfg.transport = resolveTransport(cfg, transportOverride);
    return cfg;
  });
  console.log(`jev enabled (transport: ${next.transport})`);
}

function cmdDisable() {
  writeJevJsonMerged((cfg) => {
    cfg.enabled = false;
    return cfg;
  });
  console.log('jev disabled');
}

function cmdSetKey(opts) {
  const transportOverride = opts.transport;
  if (transportOverride && !VALID_TRANSPORTS.has(transportOverride)) {
    fail(`set-key: invalid --transport "${transportOverride}" (expected vercel|typesafe)`);
    return;
  }
  const cfg = readJevJson();
  const transport = resolveTransport(cfg, transportOverride);

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

  if (transportOverride) {
    writeJevJsonMerged((c) => {
      c.transport = transportOverride;
      return c;
    });
  }

  console.log(`key saved (${key.length} chars)`);
}

async function cmdTest() {
  const cfg = readJevJson();
  if (cfg.enabled !== true) {
    fail('test: jev is not enabled — run `enable` first');
    return;
  }
  const transport = resolveTransport(cfg);
  const question = {
    type: 'noul',
    instructions: 'Is the sky typically blue on a clear day?',
    criteria: { true: 'yes', false: 'no' },
  };
  const state = 'On a clear day, the sky appears blue.';

  let r;
  try {
    r = await jevDecide({ question, state });
  } catch (_) {
    r = { ok: false, reason: 'error' };
  }

  if (r.ok) {
    console.log(`ok — latency ${r.ms}ms, confidence ${r.confidence.toFixed(2)} (transport: ${transport})`);
  } else {
    console.log(`failed: ${r.reason} (transport: ${transport})`);
    if (r.reason === 'no-key') {
      console.log('no key found — run `set-key` first');
    } else if (typeof r.reason === 'string' && /^http-401|^http-403/.test(r.reason)) {
      console.log('the key was rejected — check the key is correct AND that the transport (vercel vs typesafe) matches where the key was issued');
    }
    process.exitCode = 1;
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
  console.log(`${integration} mode set to ${value}`);
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
    case 'test': return cmdTest();
    case 'mode': return cmdMode(opts);
    default:
      console.error('usage: jev-setup.js status|enable [--transport vercel|typesafe]|disable|set-key [--transport vercel|typesafe]|test|mode <integration> on|shadow|off');
      process.exitCode = 1;
  }
}

module.exports = {
  readJevJson,
  writeJevJsonMerged,
  resolveTransport,
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
