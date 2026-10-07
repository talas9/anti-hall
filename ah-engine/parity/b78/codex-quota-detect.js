// Corpus for codex-quota-detect (PostToolUse on Agent): >= 30 payload shapes, hand written plus generated.
exports.scenarios = (lib) => {
  const out = [];
  const add = (id, payload, extra) => out.push(Object.assign({ id, payload: typeof payload === 'function' ? undefined : payload, setup: typeof payload === 'function' ? payload : undefined }, extra || {}));
  const agent = (resp, extra, input) => Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1', cwd: '/tmp', tool_input: Object.assign({ subagent_type: 'codex:codex-rescue', prompt: 'x' }, input || {}), tool_response: resp }, extra || {});
  const MSGS = [
    "You've hit your usage limit. Upgrade to Pro or try again at Oct 3rd, 2026 9:11 PM.",
    'ERROR: out of quota until 2026-10-08T12:00:00Z.',
    'out of quota until 2026-10-08T12:00:00.123+02:00',
    'Rate limit exceeded; resets at 2026-12-31T23:59:59Z.',
    'You have exceeded your rate limit. Try again at Nov 2, 2026 3:05 AM',
    'hit the usage limit, try again at Oct 3, 2026',
    'hit the usage limit, try again after Oct 3rd 2026 11:30 PM UTC',
    'The quota is exhausted',
    'Codex ran out of quota; available again at 2026-10-09T00:00:00Z.',
    'exceeded the quota\nthen more lines\nuntil tomorrow',
    'usage limit: hit your usage limit. try again at Sat, Oct 3 2026 1:00 AM GMT.',
    'ran out of usage limit try again at Feb 31 2026 10:00 AM',
    'out of quota resumes at 2020-01-01T00:00:00Z',   // already past
    'out of quota',                                      // no end time
    'OUT OF QUOTA UNTIL 2026-10-08T12:00:00Z.',
    'exceeded rate limit, try again at 12/25/2026',      // unsupported date shape -> defer or exact
    'hit your usage limit. try again at 9:11 PM',
    'exceeds the usage limit try again at Oct 3rd, 2026 9:11 PM and then later',
    'out of quota. resumes at never.',
    'out of quota until 2026-10-08',
    'out of quota until 2026-10-08T12:00',
    'hit the rate limit; resets Oct 3 2026 12:00 AM',
    'hit the rate limit; resets Oct 3 2026 00:30 AM',
    'quota exceeded (not matching order)',
    'café été: out of quota until 2026-10-08T12:00:00Z; résumé',
    'x'.repeat(30000) + ' out of quota until 2026-10-08T12:00:00Z',
    'out of quota until 2026-10-08T12:00:00Z ' + 'y'.repeat(30000),
    'out of 😀 quota',
    'hit your usage limit 😀 try again at Oct 3 2026 9:11 PM',
    'You are out of quota. Please try again after Oct 3rd, 2026 9:11 PM.',
  ];
  MSGS.forEach((m, i) => add('str-' + i, agent(m)));
  // object results (single key objects stringify exactly; multi-key objects defer when they mention quota)
  add('obj-single', agent({ result: 'out of quota until 2026-10-08T12:00:00Z.' }));
  add('obj-multi-hit', agent({ type: 'text', text: 'hit your usage limit, try again at Oct 3rd, 2026 9:11 PM.', is_error: true }));
  add('obj-multi-clean', agent({ type: 'text', text: 'all done, 3 files changed', is_error: false }));
  add('obj-arr-clean', agent({ content: [{ type: 'text', text: 'fine' }, { type: 'text', text: 'also fine' }] }));
  add('obj-arr-hit', agent({ content: [{ type: 'text', text: 'out of quota' }] }));
  add('arr-top', agent(['out of quota until 2026-10-08T12:00:00Z']));
  add('num-resp', agent(5));
  add('bool-resp', agent(true));
  add('null-resp', agent(null));
  add('empty-resp', agent(''));
  add('tool_output-field', Object.assign(agent(undefined), { tool_output: 'out of quota until 2026-10-08T12:00:00Z' }));
  add('both-fields', Object.assign(agent('fine'), { tool_output: 'out of quota' }));
  add('missing-resp', (() => { const p = agent('x'); delete p.tool_response; return p; })());
  // who the agent is
  for (const t of ['codex:codex-rescue', 'codex-rescue', 'codex:rescue', 'codex/rescue', 'Codex:Codex-Rescue', ' codex:codex-rescue ', 'codexrescue', 'codex-codex-rescue', 'codex:codex-rescue2', 'general-purpose', '', null, 5, ['codex:codex-rescue']]) add('type-' + JSON.stringify(t), agent('out of quota', {}, { subagent_type: t }));
  add('agentType', agent('out of quota', {}, { subagent_type: undefined, agentType: 'codex:codex-rescue' }));
  add('agent_type', agent('out of quota', {}, { subagent_type: undefined, agent_type: 'codex-rescue' }));
  add('type-falsy-then-ok', agent('out of quota', {}, { subagent_type: '', agentType: 'codex:codex-rescue' }));
  add('type-num-then-str', agent('out of quota', {}, { subagent_type: 5, agentType: 'codex:codex-rescue' }));
  // payload shapes
  add('not-agent', agent('out of quota', { tool_name: 'Bash' }));
  add('no-tool-name', (() => { const p = agent('out of quota'); delete p.tool_name; return p; })());
  add('no-input', (() => { const p = agent('out of quota'); delete p.tool_input; return p; })());
  add('input-string', agent('out of quota', { tool_input: 'codex:codex-rescue' }));
  add('input-null', agent('out of quota', { tool_input: null }));
  add('input-array', agent('out of quota', { tool_input: ['codex:codex-rescue'] }));
  add('payload-array', ['x']);
  add('payload-null', 'null');
  add('payload-string', '"out of quota"');
  add('payload-number', '17');
  add('malformed-json', '{"tool_name":"Agent",');
  add('empty-stdin', '');
  add('whitespace-stdin', '   \n');
  add('bom', '﻿' + JSON.stringify(agent('out of quota')));
  add('huge-extra', agent('out of quota', { junk: 'z'.repeat(200000) }));
  add('unicode-session', agent('out of quota', { session_id: 'é\u{1F600}' }));
  // switches
  add('switch-off-env', agent('out of quota until 2026-10-08T12:00:00Z.'), { env: { ANTIHALL_CODEX_QUOTA_DETECT: '0' } });
  add('switch-on-env', agent('out of quota until 2026-10-08T12:00:00Z.'), { env: { ANTIHALL_CODEX_QUOTA_DETECT: 'on' } });
  add('switch-junk-env', agent('out of quota until 2026-10-08T12:00:00Z.'), { env: { ANTIHALL_CODEX_QUOTA_DETECT: 'maybe' } });
  add('switch-off-settings', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ guards: { codexQuotaDetect: false } })); return { payload: agent('out of quota') }; });
  add('switch-off-settings-str', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ guards: { codexQuotaDetect: 'no' } })); return { payload: agent('out of quota') }; });
  add('switch-env-beats-settings', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ guards: { codexQuotaDetect: false } })); return { payload: agent('out of quota until 2026-10-08T12:00:00Z') }; }, { env: { ANTIHALL_CODEX_QUOTA_DETECT: '1' } });
  add('switch-plugin-option-off', agent('out of quota'), { env: { CLAUDE_PLUGIN_OPTION_GUARDS_CODEX_QUOTA_DETECT: 'false' } });
  add('switch-plugin-option-default', agent('out of quota'), { env: { CLAUDE_PLUGIN_OPTION_GUARDS_CODEX_QUOTA_DETECT: 'true' } });
  // existing state file merges
  const state = (obj) => (root) => { lib.write(root, 'home/.anti-hall/codex-availability.json', typeof obj === 'string' ? obj : JSON.stringify(obj)); return { payload: agent('out of quota until 2026-10-08T12:00:00Z.') }; };
  add('state-existing-probe', state({ available: true, checkedAt: Date.now() - 1000, source: 'path-probe' }));
  add('state-existing-quota', state({ available: true, checkedAt: 1, source: 'path-probe', quota: { available: false, until: 5, reason: 'old', recordedAt: 1 } }));
  add('state-corrupt', state('{not json'));
  add('state-array', state('[1,2]'));
  add('state-empty', state(''));
  add('state-extra-keys', state({ zeta: 1, alpha: [1, 2, { b: 1, a: 2 }], available: false, '7': 'x', '2': 'y' }));
  add('state-proto', state('{"__proto__":{"x":1},"a":1}'));
  add('state-lone-surrogate', state('{"a":"\\ud83d"}'));
  add('state-big-numbers', state('{"n":1e21,"m":1.5e-7,"k":12345678901234567890,"z":-0}'));
  add('state-dir-blocks-file', (root) => { lib.write(root, 'home/.anti-hall/codex-availability.json/x', 'y'); return { payload: agent('out of quota until 2026-10-08T12:00:00Z.') }; });
  // ---- future dates and time zones: the recorded `until` must agree to the millisecond ----
  const FUT = ['Oct 3rd, 2030 9:11 PM', 'Oct 3, 2030', 'October 3 2030 11:59 PM', 'Mar 10 2030 2:30 AM', 'Mar 10 2030 3:30 AM', 'Nov 3 2030 1:30 AM', 'Nov 3 2030 12:30 AM', 'Nov 3 2030 2:30 AM',
    'Sat, Oct 3 2030 1:00 AM GMT', 'Fri Oct 4 2030 1:00 AM', 'Feb 31 2030 10:00 AM', 'Feb 29 2030 10:00 AM', 'Feb 29 2032 10:00 AM', 'Dec 31 2030 11:59 PM', 'Jan 1 2031 12:00 AM', 'Jan 1 2031 12:00 PM',
    '2030-10-08T12:00:00Z', '2030-10-08T12:00:00.5Z', '2030-10-08T12:00:00.123456Z', '2030-10-08T12:00:00+05:30', '2030-10-08T12:00:00-08:00', '2030-10-08T12:00', '2030-10-08T12:00:00', '2030-10-08', '2030-03-10T02:30:00', '2030-11-03T01:30:00',
    '+002030-10-08T12:00:00Z', '2030-13-08T12:00:00Z', '2030-02-30T12:00:00Z', '2030-10-08T24:00:00Z', '2030-10-08T12:60:00Z', '2030-10-08 12:00:00', '2030/10/08', '10/08/2030', 'Oct 8 30', 'Oct 8 2030 9:11', 'Oct 8 2030 21:11', 'Oct 8 2030 9:11:30 PM UTC'];
  for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/London']) {
    FUT.forEach((d, i) => add(`fut-${tz}-${i}`, agent('hit your usage limit, try again at ' + d + '.'), { env: { TZ: tz } }));
  }
  FUT.forEach((d, i) => add('until-' + i, agent('out of quota until ' + d + '. more text'), { env: { TZ: 'America/New_York' } }));
  // ---- generated date strings ----
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'January', 'September', 'December', 'sept', 'OCT', 'oct', 'Octo', 'Marc', 'Ju', 'M', 'Maybe'];
  const WD = ['', '', '', 'Mon ', 'Monday, ', 'fri, ', 'Sat. ', 'Xyz '];
  const nfuzz = +(require('./../b78lib.js').arg('--fuzz', 300));
  for (let i = 0; i < nfuzz; i++) {
    let d;
    if (rnd() < 0.3) {
      d = `${pick(['2030', '2031', '0001', '9999', '2030', '12030'])}-${pick(['01', '02', '10', '12', '00', '13'])}-${pick(['01', '15', '28', '29', '30', '31', '00', '32'])}`;
      if (rnd() < 0.8) d += 'T' + pick(['00', '09', '12', '23', '24', '25']) + ':' + pick(['00', '30', '59', '60']) + pick(['', ':00', ':59', ':61', ':30.250', ':30.']) + pick(['', 'Z', '+01:00', '-05:30', '+0100', 'z', ' UTC', '+25:00']);
    } else {
      d = pick(WD) + pick(MON) + pick(['', '.', '']) + ' ' + pick(['1', '3', '15', '28', '29', '30', '31', '0', '32', '3rd', '22nd', '1st', '11th', '3,', '03']) + pick([' ', ', ', ',']) + pick(['2030', '2031', '2029', '30', '99', '12345', '1999', '2030']) + pick(['', ' 9:11 PM', ' 12:00 AM', ' 12:30 PM', ' 0:30 AM', ' 13:00', ' 23:59:59', ' 9:11:30 pm', ' 9:11 pm utc', ' 1:00 GMT', ' 1:00 Z', ' 25:00', ' 9:5 PM', ' 9:11 PM extra', ' EST', ' +0200', ' (UTC)']);
    }
    add('gen-' + i, agent(pick(['hit your usage limit, try again at ', 'out of quota until ', 'exceeded the quota; resets at ', 'ran out of quota, try again after ']) + d + pick(['.', '', ';', ' ok.'])), { env: { TZ: pick(['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']) } });
  }
  return out;
};
