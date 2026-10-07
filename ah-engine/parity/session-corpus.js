// Scenario corpus for the session-maintenance parity run (see session-harness.js). `build(hook, {repo})` returns the
// scenarios of one hook. Times in fixtures are tokens ({{NOW-3600000}}) expanded when the fixture is built, so every scenario
// is relative to its own clock; offsets stay at least five seconds away from any boundary the hook tests.
const fs = require('fs'), path = require('path');
const H = (rel, content) => ({ ['home/' + rel]: content });          // a file under the scenario's home directory
const P = (rel, content) => ({ ['proj/' + rel]: content });          // a file under the scenario's project directory
const merge = (...o) => Object.assign({}, ...o);
const HOUR = 3600000, DAY = 86400000;
const off = ms => (ms < 0 ? `{{NOW${ms}}}` : `{{NOW+${ms}}}`);

// ---- shared: the switch / skip / environment matrix -------------------------------------------------------------------
// `base` is a fixture in which the hook speaks (or does its job) when nothing disables it; each scenario below changes how
// it is switched.
function switchMatrix(hook, base, opt) {
  const out = [];
  const add = (id, files, extra) => out.push(Object.assign({ id: `${hook}-sw-${id}`, hook, files: merge(base.files, files || {}) }, base.extra || {}, extra || {}));
  add('plain');
  const names = [].concat(opt.env || []);
  const envVals = ['off', '0', 'false', 'no', ' OFF ', 'FALSE', 'No', 'n', 'zz', '', ' ', 'on', '1', 'true', 'yes', ' YES ', 'TRUE', '2', 'enabled'];
  if (names[0]) for (const v of envVals) add('env-' + JSON.stringify(v), {}, { env: { [names[0]]: v } });
  for (const a of names.slice(1)) for (const v of ['off', 'zz', 'on']) add('alias-' + v, {}, { env: { [a]: v } });
  const st = v => H('.anti-hall/settings.json', JSON.stringify({ [opt.section]: { [opt.key]: v } }));
  for (const v of [false, true, 'false', 'off', 'no', '0', 0, 1, 'on', 'true', null, [], {}, 'garbage', 2, ' OFF ', '']) add('settings-' + JSON.stringify(v), st(v));
  add('settings-section-not-object', H('.anti-hall/settings.json', JSON.stringify({ [opt.section]: 'x' })));
  add('settings-section-array', H('.anti-hall/settings.json', JSON.stringify({ [opt.section]: [false] })));
  add('settings-malformed', H('.anti-hall/settings.json', '{"' + opt.section + '":{'));
  add('settings-array', H('.anti-hall/settings.json', '[1,2]'));
  add('settings-empty', H('.anti-hall/settings.json', ''));
  add('settings-other-key', H('.anti-hall/settings.json', JSON.stringify({ [opt.section]: { other: false } })));
  if (names[0]) {
    add('env-on-beats-settings-off', st(false), { env: { [names[0]]: 'on' } });
    add('env-off-beats-settings-on', st(true), { env: { [names[0]]: 'off' } });
    add('env-junk-falls-to-settings', st(false), { env: { [names[0]]: 'zz' } });
  }
  const opEnv = 'CLAUDE_PLUGIN_OPTION_' + opt.option.toUpperCase();
  for (const v of ['false', 'true', '0', '1', 'off', 'garbage', '']) add('option-env-' + JSON.stringify(v), {}, { env: { [opEnv]: v } });
  add('option-env-false-settings-true', st(true), { env: { [opEnv]: 'false' } });
  add('option-env-false-settings-false', st(false), { env: { [opEnv]: 'true' } });
  const claude = o => H('.claude/settings.json', JSON.stringify(o));
  add('stored-nested', claude({ pluginConfigs: { 'anti-hall': { options: { [opt.option]: false } } } }));
  add('stored-flat', claude({ pluginConfigs: { 'anti-hall@anti-hall': { [opt.option]: false } } }));
  add('stored-both-id-wins', claude({ pluginConfigs: { 'anti-hall': { options: { [opt.option]: true } }, 'anti-hall@anti-hall': { [opt.option]: false } } }));
  add('stored-string-false', claude({ pluginConfigs: { 'anti-hall': { [opt.option]: 'false' } } }));
  add('stored-true-default', claude({ pluginConfigs: { 'anti-hall': { [opt.option]: true } } }));
  add('stored-malformed', H('.claude/settings.json', '{"pluginConfigs":'));
  add('stored-env-beats', claude({ pluginConfigs: { 'anti-hall': { [opt.option]: false } } }), { env: { [opEnv]: 'true' } });
  // skip file
  const sk = (o, id) => add('skip-' + id, H('.anti-hall/skip.json', typeof o === 'string' ? o : JSON.stringify(o)));
  sk({ [opt.guard]: off(HOUR) }, 'own-future'); sk({ [opt.guard]: off(-HOUR) }, 'own-past'); sk({ all: off(HOUR) }, 'all-future'); sk({ all: off(-HOUR) }, 'all-past');
  sk({ all: off(HOUR), [opt.guard]: off(-HOUR) }, 'all-future-own-past'); sk({ [opt.guard]: 'x' }, 'own-string'); sk({ [opt.guard]: true }, 'own-true');
  sk({ 'git-guard': off(HOUR) }, 'other-guard'); sk('{', 'malformed'); sk('', 'empty'); sk('[]', 'array'); sk('null', 'null'); sk('  ', 'blank');
  sk({ [opt.guard]: off(HOUR), all: 'x' }, 'own-future-all-junk');
  add('judge-child', {}, { env: { ANTIHALL_JUDGE_CHILD: '1' } });
  add('judge-child-0', {}, { env: { ANTIHALL_JUDGE_CHILD: '0' } });
  return out;
}

// ---- the two cache-and-probe hooks that share drift-baseline.js ---------------------------------------------------------------
function bump(v, i, d) { const p = v.split('.').map(Number); p[i] += d; for (let k = i + 1; k < 3; k++) p[k] = 0; return p.join('.'); }
function driftProbe(hook, file, baseline, optName, sw) {
  const out = [];
  const cacheFile = '.anti-hall/' + file;
  const cache = (installed, extra, checkedAt) => `{${installed === undefined ? '' : `"installed":${installed},`}${extra || ''}"checkedAt":${checkedAt === undefined ? off(-HOUR) : checkedAt}}`;
  const add = (id, files, extra) => out.push(Object.assign({ id: `${hook}-${id}`, hook, files: files || {} }, extra || {}));
  const withCache = (text, id, extra) => add(id, H(cacheFile, text), extra);
  const q = s => JSON.stringify(s);
  const newer = bump(baseline, 1, 1), older = bump(baseline, 1, -1);
  // 1. the installed value
  const installed = {
    match: q(baseline), patch: q(bump(baseline, 2, 1)), vpatch: q('v' + bump(baseline, 2, 1)), minor_up: q(newer), minor_down: q(older), major_up: q(bump(baseline, 0, 1)),
    major_down: q(bump(baseline, 0, -1)), vminor: q('v' + newer), two_part_same: q(baseline.split('.').slice(0, 2).join('.')), two_part_newer: q(newer.split('.').slice(0, 2).join('.')),
    pre: q(baseline + '-beta'), garbage: q('2.x.y'), spaces: q('  ' + newer + '  '), newline: q(newer + '\n'), tab: q('\t' + newer), nbsp: q(' ' + newer), feff: q('﻿' + newer),
    arabic: q('٢.٢.٠'), big: q('99999999999999999999.1.0'), huge: q('9'.repeat(400) + '.1.0'), exp: q('1e3.1.1'), four: q(newer + '.1'), trailing_dot: q(newer + '.'),
    leading_dot: q('.' + newer), double_dot: q('2..2'), empty: q(''), null: 'null', number: '5', bool: 'true', arr: '[]', obj: '{}', zero: q('0.0.0'), vv: q('vv' + newer), V: q('V' + newer),
    zeros: q('02.01.0238'), negative: q('-' + newer), plus: q('+' + newer), unicode: q('2.1.2٣'), long_patch: q(baseline.split('.').slice(0, 2).join('.') + '.99999999999999'),
  };
  for (const [k, v] of Object.entries(installed)) withCache(cache(v), 'installed-' + k);
  add('installed-absent', H(cacheFile, cache(undefined)));
  // 2. freshness and shape of the cache
  const ttl = DAY;
  withCache(cache(q(newer), '', off(-ttl + 10000)), 'fresh-edge-in');
  withCache(cache(q(newer), '', off(-ttl - 10000)), 'fresh-edge-out');
  withCache(cache(q(newer), '', off(60 * 1000)), 'future-checkedAt');
  withCache(cache(q(newer), '', off(3 * DAY)), 'future-3d');
  withCache(cache(q(newer), '', off(-30 * DAY)), 'stale-30d');
  withCache(cache(q(newer), '', '"' + off(-HOUR) + '"'), 'checkedAt-string');
  withCache(cache(q(newer), '', 'null'), 'checkedAt-null');
  withCache(cache(q(newer), '', 'true'), 'checkedAt-true');
  withCache(cache(q(newer), '', '1e999'), 'checkedAt-overflow');
  withCache(cache(q(newer), '', '-5'), 'checkedAt-negative');
  withCache(cache(q(newer), '', '0'), 'checkedAt-zero');
  withCache(`{"installed":${q(newer)}}`, 'no-checkedAt');
  withCache('{}', 'empty-object');
  withCache('[]', 'array'); withCache('null', 'null'); withCache('5', 'number'); withCache('"x"', 'string'); withCache('true', 'true');
  withCache('', 'empty-file'); withCache('{', 'malformed'); withCache('{"installed":"x"} trailing', 'trailing-junk'); withCache('﻿' + cache(q(newer)), 'bom');
  withCache(`{"installed":${q(newer)},"checkedAt":${off(-HOUR)},"checkedAt":${off(-2 * HOUR)}}`, 'duplicate-key');
  withCache(' \n\t' + cache(q(newer)) + '\n ', 'whitespace-around');
  withCache('{"installed":"\\ud800","checkedAt":' + off(-HOUR) + '}', 'lone-surrogate-escape', { expectDefer: true });
  add('absent');
  add('bare-home-no-state-dir', {}, { bare: true });
  add('cache-is-directory', { ['home/' + cacheFile + '/x']: '' });
  add('cache-unreadable', H(cacheFile, { content: cache(q(newer)), mode: 0o000 }));
  // 3. lastAdvised variants (dedupe), with and without extra fields to keep
  const key = `{"installed":${q(newer)},"baseline":${q(baseline)}}`;
  const la = (x, id, rest) => withCache(cache(q(newer), `${rest || ''}"lastAdvised":${x},`), 'lastAdvised-' + id);
  la(key, 'match');
  la(`{"baseline":${q(baseline)},"installed":${q(newer)}}`, 'match-reversed');
  la(`{"installed":${q(newer)},"baseline":${q(baseline)},"extra":1}`, 'match-extra-key');
  la(`{"installed":${q(newer)}}`, 'missing-baseline');
  la(`{"installed":${q(newer)},"baseline":"0.0.0"}`, 'other-baseline');
  la(`{"installed":${q(older)},"baseline":${q(baseline)}}`, 'other-installed');
  la(`{"installed":${q(newer)},"baseline":${q(baseline)}}`, 'match-with-source', '"source":"probe",');
  la('[]', 'array'); la('"x"', 'string'); la('null', 'null'); la('{}', 'empty'); la('5', 'number'); la('true', 'true'); la('false', 'false');
  la(`{"installed":220,"baseline":${q(baseline)}}`, 'number-installed');
  la(`{"installed":[${q(newer)}],"baseline":${q(baseline)}}`, 'array-installed');
  la(`{"installed":${q(newer)},"baseline":${q(baseline)}}`, 'match-trailing-fields', '"zz":{"b":1,"a":[1,2,{"c":null}]},"n":1.5,"big":12345678901234567890,');
  withCache(`{"source":"probe","installed":${q(newer)},"lastAdvised":{"installed":"x","baseline":"y"},"checkedAt":${off(-HOUR)},"tail":"é\\u0001\\n\\"q\\""}`, 'rewrite-keeps-order');
  withCache(`{"tail":1,"checkedAt":${off(-HOUR)},"installed":${q(newer)}}`, 'rewrite-appends-lastAdvised');
  withCache(`{"installed":${q(newer)},"checkedAt":${off(-HOUR)}.0}`, 'checkedAt-float-form');
  withCache(`{"installed":${q(newer)},"checkedAt":${off(-HOUR)},"n":1e21,"m":1e-7,"k":-0,"z":0.1,"w":100.0,"y":1E2,"u":123456789012345680000}`, 'rewrite-number-forms');
  withCache(`{"installed":${q('é' + newer)},"checkedAt":${off(-HOUR)}}`, 'installed-unicode');
  withCache(`{"installed":${q(newer)},"checkedAt":${off(-HOUR)},"deep":${'['.repeat(150)}${']'.repeat(150)}}`, 'deep-nesting', { expectDefer: true });
  // 4. payload shapes (the hook ignores the payload except that the engine must be able to read it)
  for (const [id, p] of [['no-session', { session_id: undefined }], ['agent', { agent_id: 'a1', agent_type: 'x' }], ['cwd-missing', { cwd: undefined }], ['unicode-cwd', { cwd: '/tmp/é/日本' }]])
    add('payload-' + id, H(cacheFile, cache(q(newer))), { payload: p });
  add('payload-malformed', H(cacheFile, cache(q(newer))), { raw: '{"hook_event_name":', expectDefer: true });
  add('payload-empty', H(cacheFile, cache(q(newer))), { raw: '', expectDefer: true });
  add('payload-null', H(cacheFile, cache(q(newer))), { raw: 'null', expectDefer: true });
  add('payload-array', H(cacheFile, cache(q(newer))), { raw: '[]', expectDefer: true });
  add('payload-other-event', H(cacheFile, cache(q(newer))), { payload: { hook_event_name: 'PreToolUse' }, expectDefer: true });
  add('payload-huge', H(cacheFile, cache(q(newer))), { payload: { junk: 'x'.repeat(300000), nested: { a: [1, 2, 3] } } });
  // 5. switches
  const base = { files: H(cacheFile, cache(q(newer))) };
  out.push(...switchMatrix(hook, base, sw));
  return out;
}

const claudeCli = () => driftProbe('claude-cli-version', 'claude-cli-version.json', '2.1.238', 'version_alerts_claude_cli',
  { section: 'versionAlerts', key: 'claudeCli', env: ['ANTIHALL_CLAUDE_CLI_VERSION_ALERT'], option: 'version_alerts_claude_cli', guard: 'claude-cli-version' });
const devswarm = () => driftProbe('devswarm-version', 'devswarm-version.json', '2.5.1', 'version_alerts_devswarm',
  { section: 'versionAlerts', key: 'devswarm', env: ['ANTIHALL_DEVSWARM_VERSION_ALERT'], option: 'version_alerts_devswarm', guard: 'devswarm-version' });

function build(hook, ctx) {
  const helpers = { H, P, merge, off, HOUR, DAY, switchMatrix };
  let list;
  switch (hook) {
    case 'claude-cli-version': list = claudeCli(); break;
    case 'devswarm-version': list = devswarm(); break;
    default: {
      try { list = require('./session-corpus-' + hook + '.js').build(ctx, helpers); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return null; throw e; }
    }
  }
  const fuzz = require('./session-corpus-fuzz.js');
  const n = { 'claude-cli-version': 160, 'devswarm-version': 160, 'version-alert': 200, 'repo-self-drift': 140, 'defect-nudge': 140, 'progress-prune': 120 }[hook] || 0;
  return list.concat(fuzz.build(hook, helpers, 20261007, n));
}
module.exports = { build, H, P, merge, off, HOUR, DAY, switchMatrix };
