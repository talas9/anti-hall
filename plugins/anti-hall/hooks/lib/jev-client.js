'use strict';
// jev-client.js — thin client for TypeSafe's Jev "System One" decision API
// (Choice / Noul primitives), reached through the Vercel AI Gateway's
// TypeSafe-compatible passthrough (default) or TypeSafe's own direct API.
//
// DEFAULT OFF. Jev is only consulted when a caller explicitly enables it via
// ~/.anti-hall/jev.json ({"enabled": true}) or ANTIHALL_JEV=1. ANTIHALL_JEV=0
// always force-disables, overriding jev.json. Every failure mode (disabled,
// missing key, timeout, non-2xx, unparsable body, malformed answer shape)
// returns {ok:false, reason} instead of throwing — this module is fail-open
// by contract; callers decide what to fall back to.
//
// The API key is read fresh on every call from env or a key file and is
// NEVER logged, echoed into a reason string, or included in any thrown/
// returned error text.
//
// Config (~/.anti-hall/jev.json), all fields optional:
//   {
//     "enabled": false,               // default false
//     "transport": "vercel",          // "vercel" (default) | "typesafe"
//     "keyFile": "~/.config/vercel/ai-gateway-key",  // default depends on transport
//     "timeoutMs": 1500,              // default 1500
//     "confidenceThreshold": 0.85     // default 0.85 (consumed by callers, not enforced here)
//   }
//
// Env overrides:
//   ANTIHALL_JEV=1        force-enable (even without jev.json)
//   ANTIHALL_JEV=0         force-disable (overrides jev.json enabled:true)
//   AI_GATEWAY_API_KEY     credential for transport:"vercel" (checked before keyFile)
//   TYPESAFE_API_KEY       credential for transport:"typesafe" (checked before keyFile)

const fs = require('fs');
const os = require('os');
const path = require('path');

const GATEWAY = {
  endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
  model: 'typesafe-ai/jev',
};
const TYPESAFE = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
};

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

function readJevConfigFile() {
  try {
    const p = path.join(os.homedir(), '.anti-hall', 'jev.json');
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// loadJevConfig() — resolve the effective config from jev.json + env. Never
// throws; missing/malformed jev.json is treated as {} (disabled).
function loadJevConfig() {
  const fileCfg = readJevConfigFile();

  let enabled = fileCfg.enabled === true || process.env.ANTIHALL_JEV === '1';
  if (process.env.ANTIHALL_JEV === '0') enabled = false;

  const transport = fileCfg.transport === 'typesafe' ? 'typesafe' : 'vercel';

  const timeoutMs = (Number.isFinite(fileCfg.timeoutMs) && fileCfg.timeoutMs > 0)
    ? fileCfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const confidenceThreshold = (Number.isFinite(fileCfg.confidenceThreshold) &&
    fileCfg.confidenceThreshold >= 0 && fileCfg.confidenceThreshold <= 1)
    ? fileCfg.confidenceThreshold
    : DEFAULT_CONFIDENCE_THRESHOLD;

  const keyFile = (typeof fileCfg.keyFile === 'string' && fileCfg.keyFile.trim())
    ? expandHome(fileCfg.keyFile.trim())
    : null;

  // Test-only escape hatch: point at a local mock server instead of the real
  // gateway/API. Never documented for end users; only consumed by our own
  // test suite so it never touches the real network.
  const endpointOverride = (typeof process.env.ANTIHALL_JEV_TEST_ENDPOINT === 'string' &&
    process.env.ANTIHALL_JEV_TEST_ENDPOINT.trim())
    ? process.env.ANTIHALL_JEV_TEST_ENDPOINT.trim()
    : null;

  return { enabled, transport, timeoutMs, confidenceThreshold, keyFile, endpointOverride };
}

function defaultKeyFilePath(transport) {
  return transport === 'typesafe'
    ? path.join(os.homedir(), '.config', 'typesafe', 'key')
    : path.join(os.homedir(), '.config', 'vercel', 'ai-gateway-key');
}

// resolveCredential(cfg) — env var first, then keyFile (explicit or default
// for the transport). Returns the trimmed key string or null. Never logs.
function resolveCredential(cfg) {
  const envVar = cfg.transport === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY';
  const envVal = process.env[envVar];
  if (typeof envVal === 'string' && envVal.trim()) return envVal.trim();

  const keyPath = cfg.keyFile || defaultKeyFilePath(cfg.transport);
  try {
    const contents = fs.readFileSync(keyPath, 'utf8').trim();
    return contents || null;
  } catch (_) {
    return null;
  }
}

// jevDecide({question, state, timeoutMs}) -> Promise<Result>
//   question: a native Jev question object, e.g.
//     {type:'noul', instructions, criteria:{true, false}}   (yes/no)
//     {type:'choice', instructions, criteria:{key: description, ...}}  (pick one; an array is rejected with HTTP 400)
//   state: the text Jev evaluates (sent verbatim as the Jev "state" field).
//   timeoutMs: optional per-call override of the configured timeout.
//
// Result (success):
//   {ok:true, answer, confidence, ms}
//     - noul question:   answer is boolean (noul >= 0.5),
//                        confidence is |noul - 0.5| * 2, in [0,1]
//     - choice question: answer is the chosen label (string),
//                        confidence is the reported confidence, in [0,1]
// Result (failure), always fail-open, never throws:
//   {ok:false, reason: 'disabled'|'no-key'|'timeout'|'network-error'|
//                       'http-<status>'|'parse-error'|'bad-response'|
//                       'bad-question'|'bad-state', ms?}
async function jevDecide({ question, state, timeoutMs } = {}) {
  if (!question || typeof question !== 'object' || (question.type !== 'choice' && question.type !== 'noul')) {
    return { ok: false, reason: 'bad-question' };
  }
  if (typeof state !== 'string' || !state.trim()) {
    return { ok: false, reason: 'bad-state' };
  }

  const cfg = loadJevConfig();
  if (!cfg.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  const apiKey = resolveCredential(cfg);
  if (!apiKey) {
    return { ok: false, reason: 'no-key' };
  }

  const transportInfo = cfg.transport === 'typesafe' ? TYPESAFE : GATEWAY;
  const endpoint = cfg.endpointOverride || transportInfo.endpoint;
  const model = transportInfo.model;
  const effectiveTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : cfg.timeoutMs;

  const body = JSON.stringify({
    state,
    model,
    questions: { decision: question },
  });

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const ms = Date.now() - start;
    if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))) {
      return { ok: false, reason: 'timeout', ms };
    }
    return { ok: false, reason: 'network-error', ms };
  }
  clearTimeout(timer);
  const ms = Date.now() - start;

  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}`, ms };
  }

  let text;
  try {
    text = await res.text();
  } catch (_) {
    return { ok: false, reason: 'parse-error', ms };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return { ok: false, reason: 'parse-error', ms };
  }

  const ans = json && json.answers && json.answers.decision;
  if (!ans || typeof ans !== 'object') {
    return { ok: false, reason: 'bad-response', ms };
  }

  if (question.type === 'choice') {
    if (typeof ans.choice !== 'string' || !ans.choice) {
      return { ok: false, reason: 'bad-response', ms };
    }
    const confidence = Number.isFinite(ans.confidence) ? ans.confidence : 0;
    return { ok: true, answer: ans.choice, confidence, ms };
  }

  // noul: a probability-like value in [0,1]; >=0.5 is "true".
  if (!Number.isFinite(ans.noul)) {
    return { ok: false, reason: 'bad-response', ms };
  }
  const noul = ans.noul;
  const answer = noul >= 0.5;
  const confidence = Math.abs(noul - 0.5) * 2;
  return { ok: true, answer, confidence, ms };
}

module.exports = {
  jevDecide,
  loadJevConfig,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONFIDENCE_THRESHOLD,
};
