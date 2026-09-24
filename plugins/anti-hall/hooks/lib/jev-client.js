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
// Hard ceiling on any configured/overridden timeout. The hook's own Stop
// timeout is far larger; a Jev call that runs close to it risks the outer
// hook timing out non-fail-open. One deadline covers request+headers+body
// (see jevDecide below), so this ceiling bounds the whole call, not just the
// time to first byte.
const MAX_TIMEOUT_MS = 3000;

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
    ? Math.min(fileCfg.timeoutMs, MAX_TIMEOUT_MS)
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

// extractCostAndUsage(json) -> {cost, tokensIn, tokensOut, model} —
// best-effort extraction of gateway/provider-reported cost/usage from a
// systemone response, never a guess. VERIFIED from official docs:
//   - https://docs.typesafe.ai/api (TypeSafe's OWN documented response shape
//     for POST /v1/systemone -- the "typesafe" direct transport this module
//     supports): top-level `model` (string) and `usage: {input_tokens,
//     output_tokens}` ARE part of the documented response. No cost/$ field is
//     documented there.
//   - https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api ("Look up a
//     generation" response fields: total_cost, market_cost, gateway_cost,
//     tokens_prompt, tokens_completion, model, id) -- but that is the
//     SEPARATE `GET /v1/generation?id=...` lookup endpoint, keyed by a
//     `gen_...` id this module never receives; it is NOT documented as part
//     of the `/typesafe/v1/systemone` PASSTHROUGH response body itself.
// So: for the "typesafe" transport, `usage.input_tokens`/`output_tokens` and
// `model` are real, documented fields and are extracted below. For the
// "vercel" passthrough transport, whether TypeSafe's `usage`/`model` fields
// survive the passthrough unchanged is UNVERIFIED (no doc states either way)
// -- the same field names are checked defensively there too, since doing so
// costs nothing extra now that `json` is already parsed, but a null result
// on that transport is the honest, expected default until proven otherwise.
// No cost/$ field is documented on either transport's systemone response
// itself, so `cost` checks the Vercel generation-lookup field names purely
// as defensive forward-compatibility, not because they're expected here.
function extractCostAndUsage(json) {
  const out = { cost: null, tokensIn: null, tokensOut: null, model: null };
  if (!json || typeof json !== 'object') return out;

  // Vercel "look up a generation" cost field names -- defensive only (see
  // comment above; not documented on this endpoint's own response body).
  for (const key of ['total_cost', 'gateway_cost', 'market_cost']) {
    if (Number.isFinite(json[key])) { out.cost = json[key]; break; }
  }

  // Vercel "look up a generation" token field names -- defensive only.
  if (Number.isFinite(json.tokens_prompt)) out.tokensIn = json.tokens_prompt;
  if (Number.isFinite(json.tokens_completion)) out.tokensOut = json.tokens_completion;

  if (json.usage && typeof json.usage === 'object') {
    // TypeSafe's OWN documented field names (docs.typesafe.ai/api) -- the
    // ones actually expected on this endpoint's response.
    if (out.tokensIn === null && Number.isFinite(json.usage.input_tokens)) out.tokensIn = json.usage.input_tokens;
    if (out.tokensOut === null && Number.isFinite(json.usage.output_tokens)) out.tokensOut = json.usage.output_tokens;
    // OpenAI-chat-completions-shaped fallback, in case a proxy ever remaps
    // them; defensive only, never observed on this endpoint.
    if (out.tokensIn === null && Number.isFinite(json.usage.prompt_tokens)) out.tokensIn = json.usage.prompt_tokens;
    if (out.tokensIn === null && Number.isFinite(json.usage.promptTokens)) out.tokensIn = json.usage.promptTokens;
    if (out.tokensOut === null && Number.isFinite(json.usage.completion_tokens)) out.tokensOut = json.usage.completion_tokens;
    if (out.tokensOut === null && Number.isFinite(json.usage.completionTokens)) out.tokensOut = json.usage.completionTokens;
  }

  // TypeSafe's documented top-level `model` field.
  if (typeof json.model === 'string' && json.model) out.model = json.model;

  return out;
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
  const effectiveTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
    : cfg.timeoutMs;

  const body = JSON.stringify({
    state,
    model,
    questions: { decision: question },
  });

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  // The timer (and controller.signal) stays live across BOTH the request and
  // the body read below — one deadline covers the whole call, not just time
  // to first byte, so a server that sends headers then stalls the body can
  // never run past effectiveTimeout. It is cleared exactly once, in the
  // finally block, after the body has been fully read (or failed).
  let res;
  try {
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
      const ms = Date.now() - start;
      if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))) {
        return { ok: false, reason: 'timeout', ms };
      }
      return { ok: false, reason: 'network-error', ms };
    }

    if (!res.ok) {
      const ms = Date.now() - start;
      return { ok: false, reason: `http-${res.status}`, ms };
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      const ms = Date.now() - start;
      if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))) {
        return { ok: false, reason: 'timeout', ms };
      }
      return { ok: false, reason: 'parse-error', ms };
    }
    const ms = Date.now() - start;

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

    const { cost, tokensIn, tokensOut, model: usageModel } = extractCostAndUsage(json);

    if (question.type === 'choice') {
      if (typeof ans.choice !== 'string' || !ans.choice) {
        return { ok: false, reason: 'bad-response', ms };
      }
      const confidence = Number.isFinite(ans.confidence) ? ans.confidence : 0;
      return { ok: true, answer: ans.choice, confidence, ms, cost, tokensIn, tokensOut, model: usageModel };
    }

    // noul: a probability-like value in [0,1]; >=0.5 is "true".
    if (!Number.isFinite(ans.noul)) {
      return { ok: false, reason: 'bad-response', ms };
    }
    const noul = ans.noul;
    const answer = noul >= 0.5;
    const confidence = Math.abs(noul - 0.5) * 2;
    return { ok: true, answer, confidence, ms, cost, tokensIn, tokensOut, model: usageModel };
  } finally {
    clearTimeout(timer);
  }
}

// parseAnswerFor(question, ans) -> {ok, answer, confidence, reason?} — the SAME
// per-type parsing jevDecide applies to json.answers.decision, generalized so
// jevDecideMulti can apply it independently to each key of a multi-question
// response. Never throws.
function parseAnswerFor(question, ans) {
  if (!ans || typeof ans !== 'object') {
    return { ok: false, reason: 'bad-response' };
  }
  if (question.type === 'choice') {
    if (typeof ans.choice !== 'string' || !ans.choice) {
      return { ok: false, reason: 'bad-response' };
    }
    const confidence = Number.isFinite(ans.confidence) ? ans.confidence : 0;
    return { ok: true, answer: ans.choice, confidence };
  }
  // noul: a probability-like value in [0,1]; >=0.5 is "true".
  if (!Number.isFinite(ans.noul)) {
    return { ok: false, reason: 'bad-response' };
  }
  const noul = ans.noul;
  const answer = noul >= 0.5;
  const confidence = Math.abs(noul - 0.5) * 2;
  return { ok: true, answer, confidence };
}

// jevDecideMulti({questions, state, timeoutMs}) -> Promise<Result>
//   questions: {key: question, ...} — MULTIPLE native Jev questions sharing ONE
//     `state`, sent in a SINGLE HTTP round-trip (Jev's `questions` field already
//     accepts multiple keys; jevDecide above just only ever used one, "decision").
//     Built for callers (e.g. mesh message triage) that need more than one
//     judgment on the SAME text without paying for more than one call.
//   state, timeoutMs: same contract as jevDecide.
//
// Result (request-level failure, always fail-open, never throws):
//   {ok:false, reason: 'disabled'|'no-key'|'timeout'|'network-error'|
//                       'http-<status>'|'parse-error'|'bad-response'|
//                       'bad-question'|'bad-state', ms?}
// Result (request-level success):
//   {ok:true, ms, answers: {key: {ok, answer, confidence}|{ok:false, reason}}}
//     — the HTTP call itself succeeded; each key is parsed and reported
//     independently, so one malformed answer never hides the others.
async function jevDecideMulti({ questions, state, timeoutMs } = {}) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) ||
    Object.keys(questions).length === 0) {
    return { ok: false, reason: 'bad-question' };
  }
  for (const key of Object.keys(questions)) {
    const q = questions[key];
    if (!q || typeof q !== 'object' || (q.type !== 'choice' && q.type !== 'noul')) {
      return { ok: false, reason: 'bad-question' };
    }
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

  const body = JSON.stringify({ state, model, questions });

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

  if (!json || typeof json.answers !== 'object' || !json.answers) {
    return { ok: false, reason: 'bad-response', ms };
  }

  const answers = {};
  for (const key of Object.keys(questions)) {
    answers[key] = parseAnswerFor(questions[key], json.answers[key]);
  }
  return { ok: true, ms, answers };
}

// CREDITS_ENDPOINT -- verified from Vercel's own docs:
// https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance
//   GET https://ai-gateway.vercel.sh/v1/credits -> {"balance": "95.50", "total_used": "4.50"}
//   (both USD, as strings)
// TypeSafe's OWN direct API documents NO equivalent (checked
// https://docs.typesafe.ai/api: "only one endpoint is documented" --
// POST /v1/systemone; no credits/balance endpoint exists there), so
// getCreditBalance only ever supports the "vercel" transport and returns
// {ok:false, reason:'unsupported-transport'} for "typesafe", plainly, rather
// than inventing an endpoint.
const CREDITS_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/credits';

// getCreditBalance({timeoutMs} = {}) -> Promise<Result>
//   {ok:true, balanceUsd, totalUsedUsd, ms}
//   {ok:false, reason: 'unsupported-transport'|'disabled'|'no-key'|'timeout'|
//                       'network-error'|'http-<status>'|'parse-error'|
//                       'bad-response', ms?}
// Fail-open like jevDecide; never throws; never logs the key. Callers (jev
// report / jev setup status) are responsible for caching this -- it must
// NEVER be called from the hook path (every call here is a real network
// request with no cache of its own).
async function getCreditBalance({ timeoutMs } = {}) {
  const cfg = loadJevConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (cfg.transport !== 'vercel') return { ok: false, reason: 'unsupported-transport' };

  const apiKey = resolveCredential(cfg);
  if (!apiKey) return { ok: false, reason: 'no-key' };

  const effectiveTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
    : cfg.timeoutMs;

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  try {
    let res;
    try {
      res = await fetch(cfg.endpointOverride || CREDITS_ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } catch (err) {
      const ms = Date.now() - start;
      if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))) {
        return { ok: false, reason: 'timeout', ms };
      }
      return { ok: false, reason: 'network-error', ms };
    }

    if (!res.ok) return { ok: false, reason: `http-${res.status}`, ms: Date.now() - start };

    let text;
    try {
      text = await res.text();
    } catch (_) {
      return { ok: false, reason: 'parse-error', ms: Date.now() - start };
    }
    const ms = Date.now() - start;

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return { ok: false, reason: 'parse-error', ms };
    }

    const balanceUsd = Number(json && json.balance);
    const totalUsedUsd = Number(json && json.total_used);
    if (!Number.isFinite(balanceUsd)) return { ok: false, reason: 'bad-response', ms };

    return { ok: true, balanceUsd, totalUsedUsd: Number.isFinite(totalUsedUsd) ? totalUsedUsd : null, ms };
  } finally {
    clearTimeout(timer);
  }
}

const CREDITS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min, per the owner's request
function creditsCachePath() {
  return path.join(os.homedir(), '.anti-hall', 'cache', 'jev-credits.json');
}
function readCreditsCache() {
  try {
    const raw = fs.readFileSync(creditsCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}
function writeCreditsCache(entry) {
  try {
    const p = creditsCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) {
    // best-effort only
  }
}

// getCreditBalanceCached({timeoutMs, forceRefresh}) -> same Result shape as
// getCreditBalance, plus `cached: true|false`. Serves a 15-minute-old cache
// (~/.anti-hall/cache/jev-credits.json) instead of hitting the network again
// -- callers (jev-report.js, jev-setup.js status) use this, never
// getCreditBalance directly, so repeated report/status runs within the
// window cost zero extra requests. This function itself must ONLY ever be
// called from a report/status/CLI path, never a hook.
async function getCreditBalanceCached({ timeoutMs, forceRefresh } = {}) {
  if (!forceRefresh) {
    const cached = readCreditsCache();
    if (cached && Number.isFinite(cached.fetchedAt) && (Date.now() - cached.fetchedAt) < CREDITS_CACHE_TTL_MS) {
      return Object.assign({}, cached.result, { cached: true });
    }
  }
  const result = await getCreditBalance({ timeoutMs });
  writeCreditsCache({ fetchedAt: Date.now(), result });
  return Object.assign({}, result, { cached: false });
}

module.exports = {
  jevDecide,
  jevDecideMulti,
  loadJevConfig,
  defaultKeyFilePath,
  expandHome,
  extractCostAndUsage,
  getCreditBalance,
  getCreditBalanceCached,
  CREDITS_ENDPOINT,
  CREDITS_CACHE_TTL_MS,
  creditsCachePath,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  MAX_TIMEOUT_MS,
};
