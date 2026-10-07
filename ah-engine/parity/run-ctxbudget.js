#!/usr/bin/env node
// Parity of the four context-budget built-in checks against their Node hooks, run as real processes:
//   limit-conserve-inject.js (UserPromptSubmit), auto-handover.js (UserPromptSubmit),
//   auto-handover-pause-nag.js (Stop), compact-advice-guard.js (Stop).
//   node run-ctxbudget.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--only <hook>] [--real 300] [--seed 1] [--conc 8] [--show 15] [--show-defer]
// These hooks have no `evaluate()` entry point, so each scenario runs the hook as a child process (stdin payload, an
// isolated copy of a fixture home, ANTIHALL_TEST_ISOLATION=1) and the engine as `ah-engine check <name>` on another copy
// of the same fixture. The engine may either answer or defer (print AHFALLBACK). Compared, byte for byte:
//   answered   exit code, stdout, stderr must equal Node's, AND the Node hook must have left the home tree exactly as the
//              fixture had it (it wrote nothing), AND the engine must have left its copy untouched. A scenario Node
//              answers with output or a state write must therefore be deferred: an answer there is a MISMATCH.
//   deferred   reported as "needed" when Node printed something other than the empty context or wrote a file, else as
//              "unneeded" (a missed offload, not a parity failure).
// Corpus per hook: hand-written scenarios (settings and skip variants, malformed payloads and state files, boundary
// numbers, unicode, huge input), then windows cut from real transcripts under ~/.claude (read only, copied into the
// scratch home), then fuzz.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), crypto = require('crypto');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);
const ENGINE = path.resolve(arg('--engine', '../target/release/ah-engine'));
const HOOKS = path.resolve(arg('--hooks'));
const ONLY = arg('--only', '');
const CONC = +arg('--conc', 8), SHOW = +arg('--show', 15), NREAL = +arg('--real', 300);
let seed = +arg('--seed', 1) >>> 0;
const R = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const pick = a => a[Math.floor(R() * a.length)];
const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();

const J = JSON.stringify;
const HOOK = {
  'limit-conserve-inject': { file: 'limit-conserve-inject.js', event: 'UserPromptSubmit' },
  'auto-handover': { file: 'auto-handover.js', event: 'UserPromptSubmit' },
  'auto-handover-pause-nag': { file: 'auto-handover-pause-nag.js', event: 'Stop' },
  'compact-advice-guard': { file: 'compact-advice-guard.js', event: 'Stop' },
};
const EMPTY = '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":""}}\n';

// ---- scenario helpers ----------------------------------------------------------------------------------------
const scen = []; // { id, hook, input (string), ctx }
const add = (hook, id, payload, ctx) => scen.push({ hook, id: `${hook}/${id}`, input: typeof payload === 'string' ? payload : J(payload), ctx: ctx || {} });
const ups = (o) => Object.assign({ hook_event_name: 'UserPromptSubmit', session_id: 'sess1', prompt: 'hello', cwd: '$HOME/proj' }, o || {});
const stop = (o) => Object.assign({ hook_event_name: 'Stop', session_id: 'sess1', cwd: '$HOME/proj', stop_hook_active: false }, o || {});
const asst = (text, usage) => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], usage } });
const asstU = usage => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage } });
const user = t => J({ type: 'user', message: { role: 'user', content: t } });
const tool = () => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
const toolRes = () => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const usage = (n) => ({ input_tokens: 10, cache_creation_input_tokens: n - 10, cache_read_input_tokens: 0 });
const codexTok = (used, max) => J({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: used }, model_context_window: max } } });
const file = (rel, lines) => ({ [rel]: Array.isArray(lines) ? lines.join('\n') + '\n' : lines });
const TP = '$HOME/t/tr.jsonl';

// ---- 1. limit-conserve-inject ---------------------------------------------------------------------------------
{
  const H = 'limit-conserve-inject';
  const CACHE = '.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json';
  const cache = (data, extra) => ({ files: { [CACHE]: J(Object.assign({ timestamp: NOW - 60e3, data, error: false }, extra || {})) } });
  const in1h = iso(NOW + 3600e3), ago1h = iso(NOW - 3600e3);
  const P = ups();
  const cases = {
    absent: {}, malformed: { files: { [CACHE]: '{not json' } }, empty: { files: { [CACHE]: '' } }, arr: { files: { [CACHE]: '[1,2]' } }, nul: { files: { [CACHE]: 'null' } }, num: { files: { [CACHE]: '5' } },
    noData: { files: { [CACHE]: J({ timestamp: NOW }) } }, dataNull: { files: { [CACHE]: J({ timestamp: NOW, data: null }) } }, dataStr: { files: { [CACHE]: J({ timestamp: NOW, data: 'x' }) } }, dataArr: { files: { [CACHE]: J({ timestamp: NOW, data: [90] }) } },
    zeros: cache({ fiveHourPercent: 0, weeklyPercent: 0 }), five84: cache({ fiveHourPercent: 84, fiveHourResetsAt: in1h }), five85: cache({ fiveHourPercent: 85, fiveHourResetsAt: in1h }),
    five86: cache({ fiveHourPercent: 86, fiveHourResetsAt: in1h }), weekly90: cache({ weeklyPercent: 90, weeklyResetsAt: in1h }), sonnet90: cache({ sonnetWeeklyPercent: 90, sonnetWeeklyResetsAt: in1h }),
    pastReset: cache({ fiveHourPercent: 99, fiveHourResetsAt: ago1h }), pastResetAll: cache({ fiveHourPercent: 99, fiveHourResetsAt: ago1h, weeklyPercent: 99, weeklyResetsAt: ago1h }),
    mixedReset: cache({ fiveHourPercent: 99, fiveHourResetsAt: ago1h, weeklyPercent: 10, weeklyResetsAt: in1h }), unparseable: cache({ fiveHourPercent: 99, fiveHourResetsAt: 'soon' }),
    localIso: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2099-01-01T00:00:00' }), dateOnly: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2099-01-01' }), offset: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2099-01-01T00:00:00+05:30' }),
    offsetPast: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2001-01-01T00:00:00-08:00' }), feb30: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2001-02-30T00:00:00Z' }), frac6: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2001-01-01T00:00:00.123456Z' }),
    badMonth: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2001-13-01T00:00:00Z' }), hour24: cache({ fiveHourPercent: 99, fiveHourResetsAt: '2001-01-01T24:00:00Z' }), numReset: cache({ fiveHourPercent: 99, fiveHourResetsAt: 5 }), emptyReset: cache({ fiveHourPercent: 99, fiveHourResetsAt: '' }),
    staleNoReset: cache({ fiveHourPercent: 99 }, { timestamp: NOW - 7 * 3600e3 }), freshNoReset: cache({ fiveHourPercent: 99 }, { timestamp: NOW - 5 * 3600e3 }), noTs: { files: { [CACHE]: J({ data: { fiveHourPercent: 99 } }) } },
    staleWithFuture: cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }, { timestamp: NOW - 9 * 3600e3 }), strPct: cache({ fiveHourPercent: '99' }), negPct: cache({ fiveHourPercent: -5 }), bigPct: cache({ fiveHourPercent: 1e9, fiveHourResetsAt: in1h }),
    expPct: { files: { [CACHE]: '{"timestamp":1,"data":{"fiveHourPercent":1e999}}' } }, uniEsc: { files: { [CACHE]: '{"timestamp":1,"data":{"x":"\\ud83d","fiveHourPercent":3}}' } }, bom: { files: { [CACHE]: '﻿' + J({ timestamp: NOW, data: { fiveHourPercent: 99 } }) } },
    modeOn: { env: { ANTIHALL_LIMIT_CONSERVE: 'on' } }, modeOff: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { ANTIHALL_LIMIT_CONSERVE: 'off' } }), modeAuto: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { ANTIHALL_LIMIT_CONSERVE: 'auto' } }),
    modeUpper: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { ANTIHALL_LIMIT_CONSERVE: ' OFF ' } }), modeJunk: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { ANTIHALL_LIMIT_CONSERVE: 'maybe' } }),
    modeSet: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { settings: { limitConserve: { mode: 'off' } } }), modeSetOn: { settings: { limitConserve: { mode: 'on' } } }, modeSetJunk: { settings: { limitConserve: { mode: 5 } } },
    modeOpt: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { CLAUDE_PLUGIN_OPTION_LIMIT_CONSERVE_MODE: 'off' } }), modeOptDefault: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { CLAUDE_PLUGIN_OPTION_LIMIT_CONSERVE_MODE: 'auto' } }),
    modeStored: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { claude: { pluginConfigs: { 'anti-hall': { options: { limit_conserve_mode: 'off' } } } } }), modeStoredOn: { claude: { pluginConfigs: { 'anti-hall@anti-hall': { limit_conserve_mode: 'on' } } } },
    thrEnv50: cache({ fiveHourPercent: 60, fiveHourResetsAt: in1h }), thrEnv99: cache({ fiveHourPercent: 98, fiveHourResetsAt: in1h }),
    skip: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { skip: { 'limit-conserve': NOW + 3600e3 } }), skipAll: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { skip: { all: NOW + 3600e3 } }),
    skipExpired: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { skip: { all: NOW - 1e3 } }), skipOther: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { skip: { 'git-guard': NOW + 3600e3 } }), skipJunk: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { skip: '{bad' }),
    judge: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { ANTIHALL_JUDGE_CHILD: '1' } }), judge0: Object.assign(cache({ fiveHourPercent: 99, fiveHourResetsAt: in1h }), { env: { ANTIHALL_JUDGE_CHILD: '0' } }),
  };
  const thr = { thrEnv50: '50', thrEnv99: '99' };
  for (const [k, c] of Object.entries(cases)) add(H, `ctx-${k}`, P, thr[k] ? Object.assign({}, c, { env: { ANTIHALL_LIMIT_THRESHOLD: thr[k] } }) : c);
  for (const t of ['abc', '0x32', ' 60 ', '1e1', '', '0', '100', '-5', '85.5', 'Infinity']) add(H, `thr-${t}`, P, Object.assign({}, cache({ fiveHourPercent: 60, fiveHourResetsAt: in1h }), { env: { ANTIHALL_LIMIT_THRESHOLD: t } }));
  for (const t of [50, 99, 0, '60', 'x', null]) add(H, `thrset-${t}`, P, Object.assign({}, cache({ fiveHourPercent: 60, fiveHourResetsAt: in1h }), { settings: { limitConserve: { threshold: t } } }));
  for (const [id, p] of Object.entries({ malformed: '{nope', empty: '', array: '[1]', scalar: '5', nul: 'null', str: '"x"', noSession: { hook_event_name: 'UserPromptSubmit' }, unicode: ups({ prompt: 'héllo \u{1F600}' }), huge: ups({ prompt: 'x'.repeat(2e6) }), sidechain: ups({ agent_id: 'a1' }) })) add(H, `payload-${id}`, p, cases.five86);
  for (const [id, p] of Object.entries({ malformed: '{nope', empty: '', array: '[1]', unicode: ups({ prompt: 'é' }) })) add(H, `payloadq-${id}`, p, {});
  // real usage caches: the file the OMC companion wrote on this machine, with its numbers moved
  for (let i = 0; i < 60; i++) {
    const v = () => R() < 0.2 ? undefined : Math.floor(R() * 120) - 5;
    const rs = () => pick([undefined, in1h, ago1h, iso(NOW + Math.floor(R() * 1e7)), iso(NOW - Math.floor(R() * 1e7))]);
    add(H, `fuzz-${i}`, P, cache({ fiveHourPercent: v(), fiveHourResetsAt: rs(), weeklyPercent: v(), weeklyResetsAt: rs(), sonnetWeeklyPercent: v(), sonnetWeeklyResetsAt: rs() }, { timestamp: pick([NOW - 60e3, NOW - 7 * 3600e3, NOW - 20 * 60e3]) }));
  }
}

// ---- 2. auto-handover and 3. auto-handover-pause-nag ------------------------------------------------------------
const latchFile = (obj, tag) => ({ [`.anti-hall/auto-handover/${tag || 'sess1'}.json`]: typeof obj === 'string' ? obj : J(obj) });
const pctFile = (obj, tag) => ({ [`.anti-hall/context-pct/${tag || 'sess1'}.json`]: J(obj) });
const merge = (...cs) => cs.reduce((a, c) => ({ files: Object.assign({}, a.files, c.files), env: Object.assign({}, a.env, c.env), settings: c.settings ? Object.assign({}, a.settings, c.settings) : a.settings, skip: c.skip || a.skip, claude: c.claude || a.claude }), {});
const tr = (...lines) => ({ files: file('t/tr.jsonl', lines) });
const withEnv = (c, env) => merge(c, { env });
const withSet = (c, settings) => merge(c, { settings });
{
  const AH = { 'auto-handover': ups, 'auto-handover-pause-nag': stop };
  const mk = (pctv, win) => tr(user('go'), asstU(usage(Math.round(pctv / 100 * (win || 200000)))));
  const states = {
    // context readings
    noTranscript: {}, emptyTr: { files: file('t/tr.jsonl', '') }, noUsage: tr(user('hi'), asst('hello')), low10: mk(10), at84: mk(84), at85: mk(85), at86: mk(86), at99: mk(99),
    est200Env: withEnv(mk(90), { ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' }), est1mEnv: withEnv(mk(90, 1e6), { ANTIHALL_CONTEXT_WINDOW_TOKENS: '1000000' }), estEnvJunk: withEnv(mk(90), { ANTIHALL_CONTEXT_WINDOW_TOKENS: 'abc' }),
    estEnvHex: withEnv(mk(90), { ANTIHALL_CONTEXT_WINDOW_TOKENS: '0x30d40' }), estEnvNeg: withEnv(mk(90), { ANTIHALL_CONTEXT_WINDOW_TOKENS: '-5' }), estEnvPrefix: withEnv(mk(90), { ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000abc' }),
    over200k: tr(user('go'), asstU(usage(250000))), over200kEnv: withEnv(tr(user('go'), asstU(usage(250000))), { ANTIHALL_CONTEXT_WINDOW_TOKENS: '1000000' }),
    sticky: merge(mk(90), { files: pctFile({ pct: 1, maxTokens: 400000, ts: 1 }) }), stickyBig: merge(tr(user('go'), asstU(usage(250000))), { files: pctFile({ pct: 1, maxTokens: 1e6, ts: 1 }) }),
    inferred: merge(mk(30), { files: { '.anti-hall/context-pct/sess1.inferred-1m.json': J({ inferred: true, ts: 1 }) } }), inferredBad: merge(mk(90), { files: { '.anti-hall/context-pct/sess1.inferred-1m.json': '{bad' } }),
    fresh95: { files: pctFile({ pct: 95, usedTokens: 190000, maxTokens: 200000, ts: NOW - 5000 }) }, fresh50: { files: pctFile({ pct: 50, usedTokens: 100000, maxTokens: 200000, ts: NOW - 5000 }) }, freshNoUsed: { files: pctFile({ pct: 95, ts: NOW - 5000 }) },
    stale95: merge(mk(10), { files: pctFile({ pct: 95, maxTokens: 200000, ts: NOW - 3600e3 }) }), ts0: merge(mk(10), { files: pctFile({ pct: 95, ts: 0 }) }), noPctField: merge(mk(10), { files: pctFile({ usedTokens: 5, ts: NOW }) }), pctStr: merge(mk(10), { files: pctFile({ pct: '95', ts: NOW }) }),
    pctNeg: { files: pctFile({ pct: -20, ts: NOW - 1000 }) }, pctHuge: { files: pctFile({ pct: 500, ts: NOW - 1000 }) }, ctxBad: merge(mk(10), { files: { '.anti-hall/context-pct/sess1.json': '{bad' } }), ctxArr: merge(mk(10), { files: { '.anti-hall/context-pct/sess1.json': '[1]' } }),
    codex60: tr(codexTok(120000, 200000)), codex90: tr(codexTok(180000, 200000)), codexZeroMax: tr(codexTok(5, 0)), codexStrMax: tr(J({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5 }, model_context_window: '200000' } } })),
    codexNoInfo: tr(J({ type: 'event_msg', payload: { type: 'token_count' } })), codexLast: tr(codexTok(180000, 200000), codexTok(10000, 200000)), codexOverMax: tr(codexTok(500000, 200000)),
    sidechainOnly: tr(J({ type: 'assistant', isSidechain: true, message: { usage: usage(190000), content: [] } })), zeroUsage: tr(asstU({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })), partialUsage: tr(asstU({ input_tokens: 190000 })),
    strUsage: tr(asstU({ input_tokens: '190000' })), arrUsage: tr(J({ type: 'assistant', message: { usage: [1] } })), usageNoMsg: tr(J({ type: 'assistant', usage: usage(190000) })), userUsage: tr(J({ type: 'user', message: { usage: usage(190000) } })),
    badLines: tr('{bad "usage"', asstU(usage(190000)), '{"usage"'), expLine: tr('{"type":"assistant","message":{"usage":{"input_tokens":1e999}}}', asstU(usage(10000))), escLine: tr('{"type":"assistant","message":{"usage":{"input_tokens":150000},"content":"\\ud83d"}}'),
    deepLine: tr('{"usage":' + '['.repeat(300) + ']'.repeat(300) + '}', asstU(usage(190000))), crlf: { files: file('t/tr.jsonl', user('go') + '\r\n' + asstU(usage(190000)) + '\r\n') }, blanks: tr('', '', asstU(usage(190000)), ''),
    // latch states
    fired: merge(mk(90), { files: latchFile({ fired: true, firedAt: NOW - 600e3, firedPct: 85, lastNagPct: 85, lastNagAt: NOW - 600e3 }) }), firedLow: merge(mk(20), { files: latchFile({ fired: true, firedAt: NOW - 600e3, firedPct: 85 }) }),
    firedNoNag: merge(mk(90), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 90, lastNagAt: NOW - 60e3 }) }), softFired: merge(mk(90), { files: latchFile({ softFired: true }) }), softFiredLow: merge(mk(20), { files: latchFile({ softFired: true }) }),
    softFiredUnknown: merge(tr(user('go'), asstU(usage(190000))), { files: latchFile({ softFired: true }) }), softOne: merge(mk(20), { files: latchFile({ softFired: 1 }) }), firedStr: merge(mk(90), { files: latchFile({ fired: 'true' }) }), latchBad: merge(mk(90), { files: latchFile('{bad') }), latchArr: merge(mk(90), { files: latchFile('[1]') }),
    latchEsc: merge(mk(20), { files: latchFile('{"fired":true,"x":"\\ud83d"}') }),
    risenStep: merge(mk(96), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 90, lastNagAt: NOW - 10e3 }) }), risenNot: merge(mk(92), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 90, lastNagAt: NOW - 10e3 }) }),
    quietElapsed: merge(mk(92), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 90, lastNagAt: NOW - 16 * 60e3 }) }), quietSamePct: merge(mk(92), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 90, lastNagAt: NOW - 16 * 60e3, lastPauseNagPct: 92 }) }),
    quietDiffPct: merge(mk(92), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 90, lastNagAt: NOW - 16 * 60e3, lastPauseNagPct: 91 }) }), noLastNagAt: merge(mk(92), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 90 }) }),
    noLastNagPct: merge(mk(92), { files: latchFile({ fired: true, firedPct: 85, lastNagAt: NOW - 10e3 }) }), noFiredPct: merge(mk(92), { files: latchFile({ fired: true, lastNagAt: NOW - 10e3 }) }), roundHalf: merge(tr(codexTok(184900, 200000)), { files: latchFile({ fired: true, lastNagPct: 90, lastNagAt: NOW - 16 * 60e3, lastPauseNagPct: 93 }) }),
    // settings
    off: withSet(mk(90), { autoHandover: { enabled: false } }), offFired: merge(withSet(mk(90), { autoHandover: { enabled: false } }), { files: latchFile({ fired: true }) }), offStr: withSet(mk(90), { autoHandover: { enabled: 'no' } }), onStr: withSet(mk(90), { autoHandover: { enabled: 'yes' } }),
    pct50: withSet(mk(60), { autoHandover: { pct: 50 } }), pct99: withSet(mk(98), { autoHandover: { pct: 99 } }), pctClamp: withSet(mk(98), { autoHandover: { pct: 500 } }), pctJunk: withSet(mk(90), { autoHandover: { pct: 'x' } }), pctStr: withSet(mk(60), { autoHandover: { pct: ' 50 ' } }),
    envPct50: withEnv(mk(60), { ANTIHALL_AUTO_HANDOVER_PCT: '50' }), envPct0: withEnv(mk(90), { ANTIHALL_AUTO_HANDOVER_PCT: '0' }), envPct0Fired: merge(withEnv(mk(90), { ANTIHALL_AUTO_HANDOVER_PCT: '0' }), { files: latchFile({ fired: true }) }), envPctJunk: withEnv(mk(90), { ANTIHALL_AUTO_HANDOVER_PCT: 'abc' }),
    envPctBlank: withEnv(mk(90), { ANTIHALL_AUTO_HANDOVER_PCT: '   ' }), envPctHalf: withEnv(mk(90), { ANTIHALL_AUTO_HANDOVER_PCT: '0.5' }), envPctNegZero: withEnv(mk(90), { ANTIHALL_AUTO_HANDOVER_PCT: '-0' }), envPctZeroJunk: withEnv(mk(90), { ANTIHALL_AUTO_HANDOVER_PCT: '0abc' }), envPct100: withEnv(mk(98), { ANTIHALL_AUTO_HANDOVER_PCT: '100' }),
    envPctHex: withEnv(mk(60), { ANTIHALL_AUTO_HANDOVER_PCT: '0x32' }), maxTok: withEnv(mk(20), { ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '30000' }), maxTokHigh: withEnv(mk(20), { ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '300000' }), maxTokSet: withSet(mk(20), { autoHandover: { maxTokens: 30000.9 } }),
    maxTokUnknown: withEnv(tr(user('go'), asstU(usage(190000))), { ANTIHALL_AUTO_HANDOVER_MAX_TOKENS: '150000' }), nagOff: merge(withSet(mk(96), { autoHandover: { nag: false } }), { files: latchFile({ fired: true, firedPct: 85, lastNagPct: 85 }) }),
    nagStep10: merge(withSet(mk(96), { autoHandover: { nagStepPct: 10 } }), { files: latchFile({ fired: true, lastNagPct: 90, lastNagAt: NOW - 10e3 }) }), quiet1: merge(withSet(mk(92), { autoHandover: { nagQuietMin: 1 } }), { files: latchFile({ fired: true, lastNagPct: 90, lastNagAt: NOW - 120e3 }) }),
    optOff: withEnv(mk(90), { CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_ENABLED: 'false' }), optDefault: withEnv(mk(90), { CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_ENABLED: 'true' }), optPct: withEnv(mk(60), { CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_PCT: '50' }), optPctDefault: withEnv(mk(90), { CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_PCT: '85' }),
    storedOff: merge(mk(90), { claude: { pluginConfigs: { 'anti-hall': { options: { auto_handover_enabled: false } } } } }), storedPct: merge(mk(60), { claude: { pluginConfigs: { 'anti-hall@anti-hall': { auto_handover_pct: 50 } } } }), settingsBad: { files: { '.anti-hall/settings.json': '{bad' } },
    skip: merge(mk(90), { skip: { 'auto-handover': NOW + 3600e3 } }), skipAll: merge(mk(90), { skip: { all: NOW + 3600e3 } }), skipExpired: merge(mk(90), { skip: { 'auto-handover': NOW - 1e3 } }), judge: withEnv(mk(90), { ANTIHALL_JUDGE_CHILD: '1' }),
  };
  const payloads = {
    plain: p => p, noSession: p => { const o = Object.assign({}, p); delete o.session_id; return o }, wsSession: p => Object.assign({}, p, { session_id: '   ' }), uniSession: p => Object.assign({}, p, { session_id: 'sés\u{1F600}sion' }), longSession: p => Object.assign({}, p, { session_id: 's'.repeat(100) }),
    numSession: p => Object.assign({}, p, { session_id: 5 }), subagentId: p => Object.assign({}, p, { agent_id: 'a1' }), subagentType: p => Object.assign({}, p, { agent_type: 'x' }), nullAgent: p => Object.assign({}, p, { agent_id: null }), emptyAgent: p => Object.assign({}, p, { agent_id: '' }),
    stopActive: p => Object.assign({}, p, { stop_hook_active: true }), stopActiveStr: p => Object.assign({}, p, { stop_hook_active: 'true' }), relTr: p => Object.assign({}, p, { transcript_path: 't/tr.jsonl' }), emptyTr: p => Object.assign({}, p, { transcript_path: '' }), numTr: p => Object.assign({}, p, { transcript_path: 5 }),
    missingTr: p => Object.assign({}, p, { transcript_path: '$HOME/t/missing.jsonl' }), dirTr: p => Object.assign({}, p, { transcript_path: '$HOME/t' }),
  };
  const rawPayloads = { malformed: '{nope', empty: '', array: '[1]', scalar: '5', nul: 'null', str: '"x"', bool: 'false', huge: null };
  for (const [hook, mkp] of Object.entries(AH)) {
    const base = mkp({ transcript_path: TP });
    for (const [k, c] of Object.entries(states)) add(hook, `state-${k}`, base, c);
    for (const [k, f] of Object.entries(payloads)) for (const sk of ['at84', 'at90', 'fired', 'sticky']) add(hook, `payload-${k}-${sk}`, f(base), sk === 'at90' ? mk(90) : states[sk] || states.at85);
    for (const [k, v] of Object.entries(rawPayloads)) add(hook, `raw-${k}`, v === null ? mkp({ transcript_path: TP, prompt: 'x'.repeat(3e6) }) : v, states.at86);
    add(hook, 'noSessionHashTag', Object.assign({}, base, { session_id: undefined }), states.fired);
    add(hook, 'housekeeping-prompt', mkp({ transcript_path: TP, prompt: 'inbox tick' }), states.fired);
  }
  // hash-tag latches: no session id, tag = sha1(transcript_path)[0:16] over the path as the hook sees it
  // cwd-dependent handover file present
  for (const hook of Object.keys(AH)) add(hook, 'handover-present', AH[hook]({ transcript_path: TP }), merge(states.fired, { files: { 'proj/.anti-hall/handovers/2026-10-07/sess1/HANDOVER.md': '# handover\n' } }));
}

// ---- 4. compact-advice-guard -----------------------------------------------------------------------------------
{
  const H = 'compact-advice-guard';
  const texts = {
    plain: 'All done, tests pass.', safeCaps: '✅ SAFE TO COMPACT NOW', safeLower: 'it is safe to compact now', safeSlash: 'safe to /compact', safeClear: 'safe to /clear', safeReset: 'safe for a context reset', safeCompaction: 'safe for compaction',
    goodPoint: 'GOOD POINT TO /compact NOW', goodClear: 'good time to clear', goodNew: 'GOOD POINT FOR /compact OR /new NOW', runCompact: 'Run `/compact focus: x`', thenCompact: 'then /compact', standalone: '/compact', bullet: '- /compact now', onlySafe: 'this code is safe', onlyCompact: 'a compact layout',
    onlyGood: 'good job, nice point', negated: 'NOT safe to compact yet', question: 'Is it safe to compact now?', quoted: 'the guard blocks "SAFE TO COMPACT" phrases', fenced: '```\n/compact\n```', retract: 'SAFE TO COMPACT\nRETRACT SAFE TO COMPACT: not yet', safeAndClear: 'safe but clear this up',
    splitWords: 'safe\nto compact', unicodeEsc: 'café safe', upper: 'SAFE TO COMPACT', kelvin: 'safe to Kompact', slashOnly: 'the /compact command exists', table: '| a | SAFE TO COMPACT |', empty: '', ws: '   ', long: 'x '.repeat(5e5) + 'safe to compact',
  };
  const lines = t => [user('go'), asst(t)];
  const mkc = (t, extra) => merge({ files: file('t/tr.jsonl', lines(t)) }, extra || {});
  const P = stop({ transcript_path: TP });
  for (const [k, t] of Object.entries(texts)) {
    add(H, `turn-${k}`, P, mkc(t));
    add(H, `lam-${k}`, Object.assign({}, P, { last_assistant_message: t }), mkc('nothing here'));
    add(H, `lamplain-${k}`, Object.assign({}, P, { last_assistant_message: 'ok' }), mkc(t));
  }
  const decl = mkc('✅ SAFE TO COMPACT NOW');
  const flip = { off: { settings: { guards: { compactAdviceGuard: false } } }, offStr: { settings: { guards: { compactAdviceGuard: 'off' } } }, optOff: { env: { CLAUDE_PLUGIN_OPTION_GUARDS_COMPACT_ADVICE_GUARD: 'false' } }, optStored: { claude: { pluginConfigs: { 'anti-hall': { options: { guards_compact_advice_guard: false } } } } },
    skip: { skip: { 'compact-advice-guard': NOW + 3600e3 } }, skipAll: { skip: { all: NOW + 3600e3 } }, skipExpired: { skip: { all: NOW - 1e3 } }, judge: { env: { ANTIHALL_JUDGE_CHILD: '1' } }, settingsBad: { files: { '.anti-hall/settings.json': '{bad' } }, junkBool: { settings: { guards: { compactAdviceGuard: 'maybe' } } } };
  for (const [k, c] of Object.entries(flip)) add(H, `ctx-${k}`, P, merge(decl, c));
  const pl = {
    subagent: Object.assign({}, P, { agent_id: 'a' }), subagentT: Object.assign({}, P, { agent_type: 'a' }), nullAgent: Object.assign({}, P, { agent_id: null }), active: Object.assign({}, P, { stop_hook_active: true }), activeStr: Object.assign({}, P, { stop_hook_active: 'true' }),
    noTr: stop({}), emptyTr: stop({ transcript_path: '' }), numTr: stop({ transcript_path: 5 }), relTr: stop({ transcript_path: 't/tr.jsonl' }), missing: stop({ transcript_path: '$HOME/t/missing.jsonl' }), dirTr: stop({ transcript_path: '$HOME/t' }), tilde: stop({ transcript_path: '~/t/tr.jsonl' }),
    lamNum: Object.assign({}, P, { last_assistant_message: 5 }), lamNull: Object.assign({}, P, { last_assistant_message: null }), lamWs: Object.assign({}, P, { last_assistant_message: '  \n' }),
  };
  for (const [k, p] of Object.entries(pl)) add(H, `payload-${k}`, p, decl);
  for (const [k, v] of Object.entries({ malformed: '{nope', empty: '', array: '[1]', scalar: '5', nul: 'null', str: '"x"' })) add(H, `raw-${k}`, v, decl);
  // with a context reading and a compact boundary, Node blocks (low context / recent compact): the engine must defer those
  const lowU = t => file('t/tr.jsonl', [user('go'), asst(t, usage(20000))]);
  const boundary = J({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' }, timestamp: iso(NOW - 5000) });
  const env200 = { ANTIHALL_CONTEXT_WINDOW_TOKENS: '200000' };
  for (const [k, t] of Object.entries(texts)) {
    add(H, `low-${k}`, P, { files: lowU(t), env: env200 });
    add(H, `lowlam-${k}`, Object.assign({}, P, { last_assistant_message: t }), { files: lowU('ok'), env: env200 });
    add(H, `recent-${k}`, P, { files: file('t/tr.jsonl', [user('go'), asst('ok'), boundary, user('next'), asst(t)]) });
    add(H, `fired-${k}`, P, merge({ files: lowU(t), env: env200 }, { files: latchFile({ fired: true, firedAt: NOW - 600e3, firedPct: 85 }) }));
    add(H, `highctx-${k}`, P, { files: file('t/tr.jsonl', [user('go'), asst(t, usage(180000))]), env: env200 });
  }
  add(H, 'low-prevblock', P, merge({ files: lowU('SAFE TO COMPACT'), env: env200 }, { files: { '.anti-hall/compact-advice/sess1.json': J({ hash: crypto.createHash('sha1').update('SAFE TO COMPACT').digest('hex'), at: 1 }) } }));
  add(H, 'low-prevblock-bad', P, merge({ files: lowU('SAFE TO COMPACT'), env: env200 }, { files: { '.anti-hall/compact-advice/sess1.json': '{bad' } }));
  // transcript shapes
  const trs = {
    emptyFile: file('t/tr.jsonl', ''), blank: file('t/tr.jsonl', '\n\n'), bad: file('t/tr.jsonl', ['{bad', asst('safe to compact')]), esc: file('t/tr.jsonl', ['{"type":"assistant","message":{"content":[{"type":"text","text":"s\\u0061fe to compact"}]}}']),
    lone: file('t/tr.jsonl', ['{"type":"assistant","message":{"content":[{"type":"text","text":"x \\ud83d safe to compact"}]}}']), expo: file('t/tr.jsonl', ['{"n":1e999}', asst('safe to compact')]), deep: file('t/tr.jsonl', ['['.repeat(300) + ']'.repeat(300), asst('safe to compact')]),
    afterTool: file('t/tr.jsonl', [user('go'), asst('safe to compact'), tool(), toolRes(), asst('done')]), beforeUser: file('t/tr.jsonl', [asst('safe to compact'), user('next prompt')]), notify: file('t/tr.jsonl', [asst('safe to compact'), user('<task-notification>x</task-notification>')]),
    sidechain: file('t/tr.jsonl', [user('go'), J({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'safe to compact' }] } })]), strContent: file('t/tr.jsonl', [user('go'), J({ type: 'assistant', message: { content: 'safe to compact' } })]),
    boundary: file('t/tr.jsonl', [user('go'), J({ type: 'system', subtype: 'compact_boundary' }), asst('safe to compact')]), codex: file('t/tr.jsonl', [J({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }), J({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'safe to compact' }] } })]),
    bigStart: file('t/tr.jsonl', [user('go'), asst('safe to compact'), ...Array.from({ length: 5000 }, (_, i) => asst('filler ' + i + ' ' + 'y'.repeat(400)))]), bigEnd: file('t/tr.jsonl', [...Array.from({ length: 5000 }, (_, i) => asst('filler ' + i + ' ' + 'y'.repeat(400))), user('go'), asst('safe to compact')]),
    bigNoNl: { 't/tr.jsonl': [user('go'), asst('safe to compact')].join('\n') }, clear: file('t/tr.jsonl', [user('go'), asst('please clear the cache')]), reset: file('t/tr.jsonl', [user('go'), asst('a reset happened')]), newCmd: file('t/tr.jsonl', [user('go'), asst('use /new for a fresh start')]),
  };
  for (const [k, f] of Object.entries(trs)) add(H, `tr-${k}`, P, { files: f });
}

// ---- real transcript windows (read only; copied into the scratch home) -------------------------------------------
{
  let list = [];
  try { list = cp.execSync(`find ${process.env.HOME}/.claude/projects ${process.env.HOME}/.codex/sessions -name '*.jsonl' -size +20k -size -6M 2>/dev/null | head -3000`, { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean); } catch (_) { list = []; }
  const DECLS = ['✅ SAFE TO COMPACT', 'safe to compact', 'Not safe to compact yet', 'Is it safe to compact?', 'RETRACT SAFE TO COMPACT: wait', 'GOOD POINT TO /compact NOW', 'all done.', 'this is safe', 'Run `/compact focus: x`'];
  let made = 0;
  for (let attempts = 0; made < NREAL && attempts < NREAL * 5 && list.length; attempts++) {
    const f = pick(list);
    let ls;
    try { ls = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch (_) { continue; }
    if (ls.length < 6) continue;
    const len = 4 + Math.floor(R() * 150), start = Math.floor(R() * Math.max(1, ls.length - len));
    const w = ls.slice(start, start + len).filter(l => l.length < 80000);
    if (R() < 0.5) w.splice(Math.floor(R() * (w.length + 1)), 0, f.includes('/.codex/') ? J({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: pick(DECLS) }] } }) : asst(pick(DECLS)));
    const c = { files: file('t/tr.jsonl', w) };
    const sid = R() < 0.7 ? 'sess1' : 'sess2';
    const fired = R() < 0.4 ? latchFile({ fired: true, firedPct: 85, lastNagPct: pick([80, 85, 90]), lastNagAt: NOW - pick([10e3, 20 * 60e3]) }, sid) : {};
    const withSet2 = pick([{}, { settings: { autoHandover: { pct: pick([20, 40, 60, 85]) } } }, { env: { ANTIHALL_CONTEXT_WINDOW_TOKENS: pick(['200000', '1000000']) } }]);
    const cc = merge(c, { files: fired }, withSet2);
    for (const hook of ['auto-handover', 'auto-handover-pause-nag']) add(hook, `real-${made}`, (hook === 'auto-handover' ? ups : stop)({ transcript_path: TP, session_id: sid }), cc);
    add('compact-advice-guard', `real-${made}`, stop({ transcript_path: TP, session_id: sid }), c);
    made++;
  }
}

// ---- running ---------------------------------------------------------------------------------------------------
const run = (cmd, args, input, env, cwd) => new Promise(res => {
  const p = cp.spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const o = [], e = [];
  p.stdout.on('data', d => o.push(d)); p.stderr.on('data', d => e.push(d));
  const to = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('close', (code, sig) => { clearTimeout(to); res({ code: code === null ? 'sig:' + sig : code, out: Buffer.concat(o).toString('utf8'), err: Buffer.concat(e).toString('utf8') }); });
  p.stdin.on('error', () => {}); p.stdin.end(input);
});
const sub = (s, home) => s.split('$HOME').join(home);
const mkHome = (dir, ctx) => {
  fs.mkdirSync(path.join(dir, '.anti-hall'), { recursive: true });
  const w = (rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  if (ctx.settings) w('.anti-hall/settings.json', typeof ctx.settings === 'string' ? ctx.settings : J(ctx.settings));
  if (ctx.skip) w('.anti-hall/skip.json', typeof ctx.skip === 'string' ? ctx.skip : J(ctx.skip));
  if (ctx.claude) w('.claude/settings.json', J(ctx.claude));
  for (const [rel, body] of Object.entries(ctx.files || {})) w(rel, body);
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
};
const snap = dir => {
  const out = {};
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n), r = rel ? rel + '/' + n : n, s = fs.lstatSync(f);
      if (s.isDirectory()) { out[r + '/'] = 'D'; walk(f, r); } else out[r] = crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
};
const diff = (a, b) => { const d = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) d.push(k); return d; };

(async () => {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'ah-par-ctxbudget-'));
  const stats = {};
  const mism = [];
  let n = 0;
  const todo = scen.filter(s => !ONLY || s.hook === ONLY);
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const sc = todo[idx++];
      const id = n++;
      const base = path.join(tmp, 's' + id);
      const hN = path.join(base, 'node'), hE = path.join(base, 'eng'), h0 = path.join(base, 'ref');
      for (const d of [hN, hE, h0]) mkHome(d, sc.ctx);
      const ref = snap(h0);
      const mkEnv = home => Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1' }, sc.ctx.env || {});
      const input = home => sub(sc.input, home);
      // payload paths name $HOME; a copy of the fixture lives under each home, so each side gets its own
      const node = await run(process.execPath, [path.join(HOOKS, HOOK[sc.hook].file)], input(hN), mkEnv(hN), '/tmp');
      const eng = await run(ENGINE, ['check', sc.hook], input(hE), mkEnv(hE), '/tmp');
      const st = stats[sc.hook] = stats[sc.hook] || { n: 0, same: 0, needed: 0, unneeded: 0, mismatch: 0, groups: {} };
      st.n++;
      const nodeWrote = diff(ref, snap(hN)), engWrote = diff(ref, snap(hE));
      const quiet = (sc.hook === 'limit-conserve-inject' || sc.hook === 'auto-handover') ? (node.out === EMPTY || node.out === '') : node.out === '';
      const nodeSilent = quiet && node.code === 0 && nodeWrote.length === 0 && node.err === '';
      const deferred = eng.out.trim() === 'AHFALLBACK';
      if (deferred) {
        if (nodeSilent) { st.unneeded++; const g = sc.id.split('/')[1].split('-')[0]; st.groups[g] = (st.groups[g] || 0) + 1; if (flag('--show-defer')) (st.list = st.list || []).push(sc.id); } else st.needed++;
        if (engWrote.length) { st.mismatch++; mism.push({ id: sc.id, why: 'engine wrote while deferring', engWrote }); }
        continue;
      }
      const sameOut = eng.code === node.code && eng.out === node.out && eng.err === node.err;
      if (sameOut && nodeWrote.length === 0 && engWrote.length === 0) { st.same++; continue; }
      st.mismatch++;
      mism.push({ id: sc.id, node: { code: node.code, out: node.out.slice(0, 200), err: node.err.slice(0, 200) }, eng: { code: eng.code, out: eng.out.slice(0, 200), err: eng.err.slice(0, 200) }, nodeWrote, engWrote, input: sc.input.slice(0, 300) });
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  let bad = 0;
  for (const [h, s] of Object.entries(stats)) {
    console.log(`${h}: scenarios=${s.n} same=${s.same} deferred-needed=${s.needed} deferred-unneeded=${s.unneeded} MISMATCH=${s.mismatch}`);
    if (Object.keys(s.groups).length) console.log('  unneeded deferrals by group: ' + J(s.groups));
    if (s.list) console.log('  unneeded: ' + s.list.slice(0, 80).join(' | '));
    bad += s.mismatch;
  }
  fs.writeFileSync(path.join(os.tmpdir(), 'ah-parity-ctxbudget-mismatches.json'), J(mism, null, 1));
  for (const m of mism.slice(0, SHOW)) console.log(J(m));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = bad ? 1 : 0;
})();
