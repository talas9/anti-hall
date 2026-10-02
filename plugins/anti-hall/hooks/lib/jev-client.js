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
// The API key is read fresh on every call (credentials.js) and is
// NEVER logged, echoed into a reason string, or included in any thrown/
// returned error text.
//
// Config (~/.anti-hall/jev.json), all fields optional:
//   {
//     "enabled": false,               // default false
//     "transport": "vercel",          // "vercel" (default) | "typesafe"
//     "fallbackTransport": "none",    // "none" (default) | "vercel" | "typesafe" (backup vendor)
//     "keyFile": "~/.config/vercel/ai-gateway-key",  // default depends on transport
//     "timeoutMs": 1500,              // default 1500
//     "confidenceThreshold": 0.85     // default 0.85 (consumed by callers, not enforced here)
//   }
//
// Env overrides:
//   ANTIHALL_JEV=1        force-enable (even without jev.json)
//   ANTIHALL_JEV=0         force-disable (overrides jev.json enabled:true)
//   CLAUDE_PLUGIN_OPTION_JEV_API_KEY  the key stored via /plugin config (jev_api_key); read first
//   CLAUDE_PLUGIN_OPTION_JEV_FALLBACK_API_KEY  the fallback vendor's key (jev_fallback_api_key)
//   AI_GATEWAY_API_KEY / TYPESAFE_API_KEY (+ keyFile)  legacy sources, read ONLY when
//                          the jev.allowLegacyKeyRead setting is on (default off)

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

let endpointRejectionLogged = false;

// loopbackEndpointOrNull(raw) — returns the trimmed URL only if it is a
// http(s) URL whose host is loopback (127.0.0.1, ::1, localhost); else null.
// A rejected non-empty value emits one diagnostic line (never the key, never
// the URL) once per process.
function loopbackEndpointOrNull(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const val = raw.trim();
  let ok = false;
  try {
    const u = new URL(val);
    ok = (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') &&
      !u.username && !u.password;
  } catch (_) { ok = false; }
  if (ok) return val;
  if (!endpointRejectionLogged) {
    endpointRejectionLogged = true;
    try { process.stderr.write('anti-hall jev: ANTIHALL_JEV_TEST_ENDPOINT* ignored (non-loopback host); using the built-in endpoint\n'); } catch (_) { /* ignore */ }
  }
  return null;
}

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

// loadJevConfig() — resolve the effective config from settings.json (jev
// section) + jev.json (legacy) + env. Never throws; missing/malformed config
// is treated as {} (disabled). settings.json's jev.* values, when present,
// win over jev.json's own fields (v0.108.0 unified settings — jev.json is
// never deleted or written to, only read as a fallback; see
// hooks/lib/settings.js / settings-schema.js).
function loadJevConfig() {
  const fileCfg = readJevConfigFile();
  let settingsCfg = {};
  try {
    settingsCfg = require('./settings.js').load().jev || {};
  } catch (_) { /* settings.js unavailable/corrupt -> fall back to jev.json only */ }
  const cfg = Object.assign({}, fileCfg, settingsCfg);

  let enabled = cfg.enabled === true || process.env.ANTIHALL_JEV === '1';
  if (process.env.ANTIHALL_JEV === '0') enabled = false;

  const transport = cfg.transport === 'typesafe' ? 'typesafe' : 'vercel';
  // A fallback equal to the primary (or anything unrecognised) is "none".
  const fallbackTransport = ((cfg.fallbackTransport === 'vercel' || cfg.fallbackTransport === 'typesafe') &&
    cfg.fallbackTransport !== transport) ? cfg.fallbackTransport : 'none';

  const timeoutMs = (Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0)
    ? Math.min(cfg.timeoutMs, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  const confidenceThreshold = (Number.isFinite(cfg.confidenceThreshold) &&
    cfg.confidenceThreshold >= 0 && cfg.confidenceThreshold <= 1)
    ? cfg.confidenceThreshold
    : DEFAULT_CONFIDENCE_THRESHOLD;

  const keyFile = (typeof cfg.keyFile === 'string' && cfg.keyFile.trim())
    ? expandHome(cfg.keyFile.trim())
    : null;

  // Test-only escape hatch: point at a local mock server instead of the real
  // gateway/API. Never documented for end users; only consumed by our own
  // test suite so it never touches the real network. SECURITY: env can be set
  // by a project-level .claude/settings.json `env` block, and every request
  // here carries the user's API key as a Bearer token, so the override is
  // honoured ONLY for a loopback host (fail-closed); anything else is ignored
  // and the built-in vendor endpoint is used.
  const endpointOverride = loopbackEndpointOrNull(process.env.ANTIHALL_JEV_TEST_ENDPOINT);

  // Per-transport variants (also loopback-only) so a test can point a primary
  // and its fallback at two different mocks; the generic override above only
  // ever applies to the primary.
  const endpointOverrides = {
    vercel: loopbackEndpointOrNull(process.env.ANTIHALL_JEV_TEST_ENDPOINT_VERCEL),
    typesafe: loopbackEndpointOrNull(process.env.ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE),
  };

  return { enabled, transport, fallbackTransport, timeoutMs, confidenceThreshold, keyFile, endpointOverride, endpointOverrides };
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

// resolveCredential(cfg, role) — plugin option env first (jev_api_key for the
// primary, jev_fallback_api_key for role 'fallback': two vendors, two keys);
// the legacy env var / keyFile are read ONLY when jev.allowLegacyKeyRead is on
// (see credentials.js). The explicit jev.keyFile belongs to the primary; the
// fallback always uses its own transport's default key file. Returns the
// trimmed key string or null. Never logs.
let keyFileRejectionReported = false;
function resolveCredential(cfg, role) {
  const cred = require('./credentials.js');
  const fb = role === 'fallback';
  const transport = fb ? cfg.fallbackTransport : cfg.transport;
  const r = cred.resolveKey('jev', {
    transport,
    role: fb ? 'fallback' : 'primary',
    keyFile: (!fb && cfg.keyFile) || defaultKeyFilePath(transport),
  });
  if (r.rejected && !keyFileRejectionReported) {
    keyFileRejectionReported = true; // one line per process, never the content
    try { process.stderr.write('anti-hall: ' + cred.rejectedNotice(r.rejected) + '\n'); } catch (_) { /* best-effort */ }
  }
  return r.key;
}

// ---------------------------------------------------------------------------
// Fallback transport (jev.fallbackTransport). ONE choke point: every decision
// call goes through runWithFallback. The primary transport is tried first; on
// a fallback-ELIGIBLE failure, and only when a key for the fallback transport
// resolves, ONE retry goes to the fallback transport inside the SAME total
// time budget (never longer than the caller asked for).
//
// ELIGIBLE (the primary vendor is unavailable / out of balance, not
// misconfigured): timeout, network error, HTTP 5xx, HTTP 402, HTTP 429, and a
// 400/403 whose body explicitly names insufficient balance/credits/quota.
// NOT ELIGIBLE: every other 4xx. 401/403 are deliberately NOT eligible: a
// rejected primary key is a configuration error the owner must see, and
// silently masking it with the backup would hide it until the backup also
// ran dry. parse-error / bad-response (the server answered 200) are not
// eligible either. UNVERIFIED against real vendor responses: which status
// each vendor returns for an exhausted balance (402 and 429 are both treated
// as eligible because neither is known).
// ---------------------------------------------------------------------------
const BREAKER_THRESHOLD = 3;                 // consecutive eligible failures
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;   // primary skipped this long, then probed
const MIN_FALLBACK_MS = 150;                 // below this no real call can finish: skip the fallback
const FALLBACK_RESERVE_MS = 600;             // time held back from the primary for the fallback
const BALANCE_BODY_RE = /insufficient|credit|balance|quota|billing/i;

function transportInfoFor(transport) {
  return transport === 'typesafe' ? TYPESAFE : GATEWAY;
}

// endpointFor(cfg, transport, role) — built-in endpoint unless a loopback test
// override applies: the per-transport one always, the generic one for the
// primary only (so a primary and its fallback never share one mock).
function endpointFor(cfg, transport, role) {
  const per = cfg.endpointOverrides && cfg.endpointOverrides[transport];
  if (per) return per;
  if (role === 'primary' && cfg.endpointOverride) return cfg.endpointOverride;
  return transportInfoFor(transport).endpoint;
}

function breakerPath() {
  return path.join(require('../../companion/lib/test-home-guard.js').resolveHome(undefined), '.anti-hall', 'cache', 'jev-breaker.json');
}
// Breaker state: {primary, fails, openUntil}. Missing, corrupt or for another
// primary transport -> fresh. Fail-open: any I/O error means "closed".
function readBreaker(primary) {
  try {
    const j = JSON.parse(fs.readFileSync(breakerPath(), 'utf8'));
    if (j && typeof j === 'object' && j.primary === primary && Number.isFinite(j.fails) && j.fails >= 0) {
      return { fails: j.fails, openUntil: Number.isFinite(j.openUntil) ? j.openUntil : 0 };
    }
  } catch (_) { /* fresh */ }
  return { fails: 0, openUntil: 0 };
}
function writeBreaker(primary, state) {
  try {
    const p = breakerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ primary, fails: state.fails, openUntil: state.openUntil }), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) { /* best-effort: a lost write only delays the breaker */ }
}
function breakerSkipsPrimary(primary) {
  const s = readBreaker(primary);
  return s.fails >= BREAKER_THRESHOLD && Date.now() < s.openUntil;
}
// Success closes the breaker; an eligible failure counts. At/after the
// threshold every further failure (including a failed cooldown probe) re-opens
// it for a fresh cooldown. Concurrent processes may lose an update (last
// writer wins) — acceptable for a heuristic.
function breakerRecord(primary, ok) {
  const s = readBreaker(primary);
  if (ok) {
    if (s.fails === 0) return;
    writeBreaker(primary, { fails: 0, openUntil: 0 });
    return;
  }
  const fails = s.fails + 1;
  writeBreaker(primary, { fails, openUntil: fails >= BREAKER_THRESHOLD ? Date.now() + BREAKER_COOLDOWN_MS : 0 });
}

function fallbackEligible(r) {
  if (!r || r.ok) return false;
  if (r.reason === 'timeout' || r.reason === 'network-error') return true;
  const m = /^http-(\d{3})$/.exec(String(r.reason));
  if (!m) return false;
  const s = Number(m[1]);
  return s >= 500 || s === 402 || s === 429 || ((s === 400 || s === 403) && r.balance === true);
}

// postSystemone — one HTTP attempt against one transport under ONE deadline
// covering request, headers and body. -> {ok:true, json, ms} | {ok:false,
// reason, ms, balance?}. Never throws; the key goes only into the header.
async function postSystemone({ endpoint, apiKey, body, timeoutMs }) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const isAbort = (err) => err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
  try {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      return { ok: false, reason: isAbort(err) ? 'timeout' : 'network-error', ms: Date.now() - start };
    }

    if (!res.ok) {
      const out = { ok: false, reason: `http-${res.status}`, ms: Date.now() - start };
      if (res.status === 400 || res.status === 403) {
        // Only to classify an explicit balance error; the body is never logged.
        try { out.balance = BALANCE_BODY_RE.test((await res.text()).slice(0, 2048)); } catch (_) { /* leave unset */ }
      }
      return out;
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      return { ok: false, reason: isAbort(err) ? 'timeout' : 'parse-error', ms: Date.now() - start };
    }
    const ms = Date.now() - start;
    let json;
    try { json = JSON.parse(text); } catch (_) { return { ok: false, reason: 'parse-error', ms }; }
    return { ok: true, json, ms };
  } finally {
    clearTimeout(timer);
  }
}

async function attemptTransport(cfg, transport, role, apiKey, bodyFor, parse, timeoutMs) {
  const r = await postSystemone({
    endpoint: endpointFor(cfg, transport, role),
    apiKey,
    body: bodyFor(transportInfoFor(transport).model),
    timeoutMs,
  });
  const out = r.ok ? parse(r.json, r.ms) : { ok: false, reason: r.reason, ms: r.ms, balance: r.balance };
  if (out.balance === undefined) delete out.balance;
  out.transport = transport;
  return out;
}

// runWithFallback(cfg, totalMs, bodyFor(model), parse(json, ms)) -> Result.
// totalMs is the WHOLE budget for primary + fallback. With a fallback in play
// the primary is held to totalMs - FALLBACK_RESERVE_MS (a primary timeout
// would otherwise leave nothing for the backup); a fallback with less than
// MIN_FALLBACK_MS left is skipped. While the breaker is open the primary is
// skipped and the fallback gets the full budget. Results carry `transport`
// (the one that answered / last tried); a fallback-served result also
// carries fellBack:true, and a failure after both attempts reports the
// PRIMARY's reason (+ fallbackReason).
async function runWithFallback(cfg, totalMs, bodyFor, parse, only) {
  const fbTransport = cfg.fallbackTransport;
  // `only` pins ONE transport (jev-setup test): 'fallback' tries just the
  // backup, 'primary' just the primary; no breaker, no retry.
  if (only === 'fallback') {
    if (fbTransport === 'none') return { ok: false, reason: 'no-fallback' };
    const k = resolveCredential(cfg, 'fallback');
    if (!k) return { ok: false, reason: 'no-key', transport: fbTransport };
    return attemptTransport(cfg, fbTransport, 'fallback', k, bodyFor, parse, totalMs);
  }
  const primaryKey = resolveCredential(cfg);
  if (!primaryKey) return { ok: false, reason: 'no-key', transport: cfg.transport };

  const fbKey = (only !== 'primary' && fbTransport !== 'none') ? resolveCredential(cfg, 'fallback') : null;
  if (!fbKey) return attemptTransport(cfg, cfg.transport, 'primary', primaryKey, bodyFor, parse, totalMs);

  const t0 = Date.now();
  let primaryRes = null;
  if (!breakerSkipsPrimary(cfg.transport)) {
    const reserve = Math.min(FALLBACK_RESERVE_MS, Math.floor(totalMs * 0.4));
    primaryRes = await attemptTransport(cfg, cfg.transport, 'primary', primaryKey, bodyFor, parse, totalMs - reserve);
    if (primaryRes.ok) { breakerRecord(cfg.transport, true); return primaryRes; }
    if (!fallbackEligible(primaryRes)) return primaryRes;
    breakerRecord(cfg.transport, false);
  }

  const remaining = totalMs - (Date.now() - t0);
  if (remaining < MIN_FALLBACK_MS) return primaryRes || { ok: false, reason: 'timeout', transport: cfg.transport };

  const fbRes = await attemptTransport(cfg, fbTransport, 'fallback', fbKey, bodyFor, parse, remaining);
  if (fbRes.ok) { fbRes.fellBack = true; return fbRes; }
  if (!primaryRes) return fbRes;
  primaryRes.fallbackReason = fbRes.reason;
  return primaryRes;
}
// jevDecide({question, state, timeoutMs}) -> Promise<Result>
//   question: a native Jev question object, e.g.
//     {type:'noul', instructions, criteria:{true, false}}   (yes/no)
//     {type:'choice', instructions, criteria:{key: description, ...}}  (pick one; an array is rejected with HTTP 400)
//   state: the text Jev evaluates (sent verbatim as the Jev "state" field).
//   timeoutMs: optional per-call override of the configured timeout.
//   only: 'primary' | 'fallback' pins one transport (jev-setup test only).
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
//   Failure/success results also carry `transport` (which vendor answered or was
//   last tried); a fallback-served success carries fellBack:true. See
//   runWithFallback.
async function jevDecide({ question, state, timeoutMs, only } = {}) {
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

  const effectiveTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
    : cfg.timeoutMs;

  return runWithFallback(cfg, effectiveTimeout,
    (model) => JSON.stringify({ state, model, questions: { decision: question } }),
    (json, ms) => {
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
    }, only);
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

  const effectiveTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : cfg.timeoutMs;

  return runWithFallback(cfg, effectiveTimeout,
    (model) => JSON.stringify({ state, model, questions }),
    (json, ms) => {
      if (!json || typeof json.answers !== 'object' || !json.answers) {
        return { ok: false, reason: 'bad-response', ms };
      }
      const answers = {};
      for (const key of Object.keys(questions)) {
        answers[key] = parseAnswerFor(questions[key], json.answers[key]);
      }
      return { ok: true, ms, answers };
    });
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
  // The balance endpoint is Vercel's: the primary when it is vercel, else the
  // fallback when THAT is vercel (the typical "TypeSafe primary, Vercel
  // backup" setup is exactly where the backup's balance matters).
  const role = cfg.transport === 'vercel' ? 'primary' : (cfg.fallbackTransport === 'vercel' ? 'fallback' : null);
  if (!role) return { ok: false, reason: 'unsupported-transport' };

  const apiKey = resolveCredential(cfg, role);
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
      res = await fetch(cfg.endpointOverrides.vercel || (role === 'primary' && cfg.endpointOverride) || CREDITS_ENDPOINT, {
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
  resolveCredential,
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
