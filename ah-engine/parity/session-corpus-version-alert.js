// version-alert scenarios (see session-corpus.js). The running plugin is a copy whose plugin.json says 1.2.3 unless a scenario
// says otherwise; the Node hook reads that file, the engine reads the same one.
exports.build = function (ctx, h) {
  const { H, merge, off, HOUR, DAY, switchMatrix } = h;
  const out = [];
  const hook = 'version-alert';
  const RUN = '1.2.3';
  const plug = v => ({ version: v });
  const CHECK = '.anti-hall/version-check.json';
  const MARK = '.anti-hall/version-alert-reload.json';
  const MIR = '.claude/plugins/cache/anti-hall/anti-hall/';
  const REG = '.claude/plugins/installed_plugins.json';
  const q = JSON.stringify;
  const add = (id, files, extra) => out.push(Object.assign({ id: `${hook}-${id}`, hook, plugin: plug(RUN), files: files || {} }, extra || {}));
  const rc = (latest, checkedAt, rest) => `{"latest":${latest},${rest || ''}"checkedAt":${checkedAt === undefined ? off(-HOUR) : checkedAt}}`;
  const remote = (latest, extra, id, spec) => add(id, H(CHECK, rc(q(latest), undefined, extra)), spec);

  // ---- case 1: the remote-latest cache -------------------------------------------------------------------------------
  const latests = ['1.2.4', '1.3.0', '2.0.0', '1.2.3', '1.2.2', '0.9.9', 'v1.2.4', '1.2.4-beta', '1.2', '1.2.4.5', '01.02.04', ' 1.2.4', '1.2.4 ', '1.2.x', '', 'x.y.z', '1.2.9999999999999999999',
    '1.2.-1', '1.2.+4', '-1.2.4', '1.2.4abc', '1.2.4e1', '1..4', '٢.٢.٤', '1.2.4\n', '10.0.0', '1.10.0', '1.2.10', 'vv1.2.4', 'V1.2.4', '1.2.4 ', '1e2.0.0', '0x10.0.0', '1.2.3.1', '999999.0.0'];
  latests.forEach((l, i) => remote(l, '', 'latest-' + i));
  add('latest-number', H(CHECK, rc('5')));
  add('latest-null', H(CHECK, rc('null')));
  add('latest-missing', H(CHECK, `{"checkedAt":${off(-HOUR)}}`));
  add('latest-array', H(CHECK, rc('["1.2.4"]')));
  const ttl = 2 * HOUR;
  add('ttl-edge-in', H(CHECK, rc(q('1.2.4'), off(-ttl + 10000))));
  add('ttl-edge-out', H(CHECK, rc(q('1.2.4'), off(-ttl - 10000))));
  add('ttl-stale-1d', H(CHECK, rc(q('1.2.4'), off(-DAY))));
  add('ttl-future', H(CHECK, rc(q('1.2.4'), off(HOUR))));
  add('ttl-checkedAt-string', H(CHECK, rc(q('1.2.4'), '"x"')));
  add('ttl-checkedAt-null', H(CHECK, rc(q('1.2.4'), 'null')));
  add('absent');
  add('bare-home', {}, { bare: true });
  for (const [id, t] of [['empty', ''], ['malformed', '{"latest":'], ['array', '[]'], ['null', 'null'], ['string', '"x"'], ['bom', '﻿' + rc(q('1.2.4'))], ['junk-after', rc(q('1.2.4')) + 'x'], ['whitespace', ' \n' + rc(q('1.2.4')) + ' \n']]) add('cache-' + id, H(CHECK, t));
  add('cache-dir', { ['home/' + CHECK + '/x']: '' });
  add('cache-unreadable', H(CHECK, { content: rc(q('1.2.4')), mode: 0 }));
  add('cache-surrogate', H(CHECK, rc('"\\ud800"')), { expectDefer: true });

  // ---- case 1 dedupe and the session id --------------------------------------------------------------------------------------
  const key = (sid, latest, running) => `{"case":"update","sessionId":${q(sid)},"latest":${q(latest || '1.2.4')},"running":${q(running || RUN)}}`;
  const la = (x, id, payload, rest) => add('dedupe-' + id, H(CHECK, rc(q('1.2.4'), undefined, `${rest || ''}"lastAdvised":${x},`)), { payload });
  la(key('sess-1'), 'match', {}); la(key('sess-2'), 'other-session', {}); la(key('sess-1', '1.2.5'), 'other-latest', {}); la(key('sess-1', '1.2.4', '1.2.0'), 'other-running', {});
  la(key('sess-1'), 'match-no-session-id', { session_id: undefined }); la(key(''), 'match-empty-id', { session_id: '' });
  la(key('sess-1').replace('{', '{"zz":1,'), 'extra-key', {}); la('[]', 'array', {}); la('"x"', 'string', {}); la('null', 'null', {}); la('{}', 'empty', {});
  la(`{"sessionId":"sess-1","running":${q(RUN)},"latest":"1.2.4","case":"update"}`, 'match-reordered', {});
  la(key('é日本'), 'match-unicode-session', { session_id: 'é日本' });
  la(key('sess-1'), 'match-number-session', { session_id: 5 });
  la(key('sess-1'), 'match-extra-fields-kept', {}, '"source":"probe","n":1.50,');
  add('session-none', H(CHECK, rc(q('1.2.4'))), { payload: { session_id: undefined } });
  add('session-empty', H(CHECK, rc(q('1.2.4'))), { payload: { session_id: '' } });
  add('session-number', H(CHECK, rc(q('1.2.4'))), { payload: { session_id: 7 } });
  add('session-unicode', H(CHECK, rc(q('1.2.4'))), { payload: { session_id: 'é\u0001\n"日本😀' } });
  add('session-long', H(CHECK, rc(q('1.2.4'))), { payload: { session_id: 'x'.repeat(10000) } });
  for (const [id, p] of [['agent-id', { agent_id: 'a' }], ['agent-type', { agent_type: 'Explore' }], ['agent-empty', { agent_id: '' }], ['agent-zero', { agent_id: 0 }], ['agent-obj', { agent_id: {} }], ['agent-arr', { agent_type: [] }],
    ['agent-false', { agent_id: false }], ['sidechain-true', { isSidechain: true }], ['sidechain-str', { isSidechain: 'true' }], ['sidechain-1', { is_sidechain: 1 }], ['sidechain-snake-true', { is_sidechain: true }], ['sidechain-false', { isSidechain: false }]])
    add('subagent-' + id, H(CHECK, rc(q('1.2.4'))), { payload: p });
  add('payload-malformed', H(CHECK, rc(q('1.2.4'))), { raw: '{', expectDefer: true });
  add('payload-empty', H(CHECK, rc(q('1.2.4'))), { raw: '', expectDefer: true });
  add('payload-null', H(CHECK, rc(q('1.2.4'))), { raw: 'null', expectDefer: true });
  add('payload-string', H(CHECK, rc(q('1.2.4'))), { raw: '"x"', expectDefer: true });
  add('payload-other-event', H(CHECK, rc(q('1.2.4'))), { payload: { hook_event_name: 'Stop' }, expectDefer: true });

  // ---- the running version ---------------------------------------------------------------------------------------------------
  for (const v of ['1.2.3', 'v1.2.3', '1.2', '1.2.3.4', '1.2.3-beta', '0.0.1', '10.0.0', '1.10.0', 'x', '1.2.3 ', ' 1.2.3', '1.2.4', '2.0.0', '1.3', '1.2.x', '01.02.03', '1.2.3\n', '1e1.2.3', '1.2.3abc', '٣.٢.١'])
    add('running-' + JSON.stringify(v), H(CHECK, rc(q('1.2.4'))), { plugin: plug(v) });
  for (const [id, t] of [['absent', null], ['empty', ''], ['malformed', '{'], ['array', '[]'], ['null', 'null'], ['number-version', '{"version":5}'], ['empty-version', '{"version":""}'], ['no-version', '{}'],
    ['junk-after', '{"version":"1.2.3"} x'], ['bom', '﻿{"version":"1.2.3"}'], ['version-null', '{"version":null}'], ['version-array', '{"version":["1.2.3"]}'], ['nested', '{"a":{"version":"1.2.3"}}']])
    add('plugin-json-' + id, H(CHECK, rc(q('1.2.4'))), { plugin: { pluginJson: t } });
  add('plugin-json-surrogate', H(CHECK, rc(q('1.2.4'))), { plugin: { pluginJson: '{"version":"\\ud800"}' }, expectDefer: true });

  // ---- case 2: a newer release is already mirrored locally ---------------------------------------------------------------------
  const cl = (title, bullets) => `# Changelog\n\n## ${title}\n\n${bullets}\n\n## 1.2.3\n\n- the old one\n`;
  const dirs = (...names) => merge(...names.map(n => ({ ['home/' + MIR + n + '/']: '' })));
  add('mirror-v-prefixed', dirs('v1.2.4'));
  add('mirror-plain', dirs('1.2.4'));
  add('mirror-equal', dirs('v1.2.3'));
  add('mirror-older', dirs('v1.2.2'));
  add('mirror-both-forms', dirs('1.2.4', 'v1.2.4'));
  add('mirror-many', dirs('v1.2.4', 'v1.2.10', 'v1.3.0', 'v1.2.9', 'v0.9.0', 'v1.10.0'));
  add('mirror-sha-dir', dirs('3928cc1257d9', 'v1.2.2'));
  add('mirror-sha-only', dirs('3928cc1257d9'));
  add('mirror-bad-names', dirs('v1.2', '1.2.4.5', 'v1.2.x', '1.2.4-beta', ' 1.2.4', '1.2.4 ', 'v01.02.04'));
  add('mirror-file-not-dir', H(MIR + 'v1.2.4', 'x'));
  add('mirror-symlink-dir', merge(dirs('target'), { ['home/' + MIR + 'v1.2.4']: { link: '{{HOME}}/' + MIR + 'target' } }));
  add('mirror-empty-root', { ['home/' + MIR]: '' });
  add('mirror-plus-newer-remote', merge(dirs('v1.2.4'), H(CHECK, rc(q('1.9.9')))));
  add('mirror-and-stale-remote', merge(dirs('v1.2.4'), H(CHECK, rc(q('1.9.9'), off(-DAY)))));
  add('mirror-vs-v-running', dirs('v1.2.4'), { plugin: plug('v1.2.3') });
  add('mirror-running-weird', dirs('v1.2.4'), { plugin: plug('1.2.x') });
  add('mirror-running-two-part', dirs('v1.2.4'), { plugin: plug('1.2') });
  add('mirror-running-newer-prerelease', dirs('v1.2.4'), { plugin: plug('1.2.3-rc.1') });
  add('mirror-unicode-running', dirs('v1.2.4'), { plugin: plug('1.2.3 é x') });
  // the headline from the mirrored CHANGELOG.md
  const logs = {
    standard: cl('1.2.4 — 2026', '- Fixed the thing\n- second'),
    vheading: cl('v1.2.4', '- Fixed the thing'),
    nospace: cl('', '').replace('## \n', '##1.2.4\n') + '- x\n',
    longer: cl('1.2.40', '- not this one'),
    suffix: cl('1.2.4x', '- not this one'),
    underscore: cl('1.2.4_beta', '- not this one'),
    hyphen: cl('1.2.4-rc', '- the rc line'),
    tab: cl('1.2.4', '- t').replace('## 1', '##\t1'),
    nbsp: cl('1.2.4', '- nbsp').replace('## 1', '## 1'),
    crlf: '# C\r\n\r\n## 1.2.4\r\n\r\n- crlf line\r\n\r\n## 1.2.3\r\n- old\r\n',
    bulletNoSpace: cl('1.2.4', '-x\n- ok after'),
    bulletEmpty: cl('1.2.4', '-\n- ok after'),
    bulletSpaces: cl('1.2.4', '-   \n- ok after'),
    bulletNbsp: cl('1.2.4', '- spaced'),
    bulletLs: cl('1.2.4', '- before after'),
    bulletCr: cl('1.2.4', '- before\rafter'),
    bulletIndent: cl('1.2.4', '   - indented\n- later'),
    bulletStar: cl('1.2.4', '* star\n- dash'),
    long: cl('1.2.4', '- ' + 'abcdefghij'.repeat(30)),
    exactly160: cl('1.2.4', '- ' + 'x'.repeat(160)),
    emoji159: cl('1.2.4', '- ' + 'x'.repeat(159) + '😀 tail'),
    emoji158: cl('1.2.4', '- ' + 'x'.repeat(158) + '😀 tail'),
    cjk: cl('1.2.4', '- 日本語のテキスト'.repeat(30)),
    beforeHeading: '- first line before any heading\n' + cl('1.2.4', '- in section'),
    otherVersionOnly: cl('1.2.5', '- other'),
    emptySection: '## 1.2.4\n\n## 1.2.3\n- old only\n',
    h3: '## 1.2.4\n\n### Fixed\n\n- under h3\n',
    twice: '## 1.2.4\n\n## 1.2.3\n- old\n\n## 1.2.4\n\n- second chance\n',
    noBullets: '## 1.2.4\n\nplain paragraph only\n',
    ws: cl('1.2.4', '-  \t lots of space  \t '),
    html: cl('1.2.4', '- <b>bold</b> & "quotes" \\ back'),
    ctl: cl('1.2.4', '- ctl\u0001\u0007 tab\there'),
    empty: '', bom: '﻿' + cl('1.2.4', '- bom'),
  };
  for (const [id, text] of Object.entries(logs)) {
    const cut = id === 'emoji159' ? { expectDefer: true } : {}; // JavaScript would print half a surrogate pair: Node decides
    add('changelog-' + id + '-v', merge(dirs('v1.2.4'), H(MIR + 'v1.2.4/CHANGELOG.md', text)), cut);
    if (['standard', 'hyphen', 'crlf', 'emoji159'].includes(id)) add('changelog-' + id + '-plain', merge(dirs('1.2.4'), H(MIR + '1.2.4/CHANGELOG.md', text)), cut);
  }
  add('changelog-is-dir', { ['home/' + MIR + 'v1.2.4/CHANGELOG.md/x']: '' });
  add('changelog-unreadable', H(MIR + 'v1.2.4/CHANGELOG.md', { content: logs.standard, mode: 0 }));
  add('changelog-huge', H(MIR + 'v1.2.4/CHANGELOG.md', cl('1.2.4', '- first') + ('- filler line\n'.repeat(60000))));

  // the harness registry (installed_plugins.json) decides between the three texts
  const regv = (v, scope) => ({ version: 2, plugins: { 'anti-hall@anti-hall': [Object.assign({ version: v }, scope ? { scope } : {})] } });
  const withReg = (id, reg, extra) => add('registry-' + id, merge(dirs('v1.2.4'), H(REG, typeof reg === 'string' ? reg : q(reg))), extra);
  withReg('older-than-mirrored', regv('1.2.3', 'user'));
  withReg('equals-mirrored', regv('1.2.4', 'user'));
  withReg('newer-than-mirrored', regv('1.2.5', 'user'));
  withReg('v-prefixed', regv('v1.2.4', 'user'));
  withReg('prerelease', regv('1.2.4-beta', 'user'));
  withReg('prerelease-older', regv('1.2.3-beta', 'user'));
  withReg('plus-build', regv('1.2.4+build.7', 'user'));
  withReg('invalid-semver', regv('1.2', 'user'));
  withReg('invalid-chars', regv('1.2.4/../x', 'user'));
  withReg('suffix-underscore', regv('1.2.4-be_ta', 'user'));
  withReg('whitespace', regv(' 1.2.4 ', 'user'));
  withReg('big-V', regv('V1.2.4', 'user'));
  withReg('no-scope', regv('1.2.2'));
  withReg('two-scopes', { version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'project', version: '1.2.5' }, { scope: 'user', version: '1.2.2' }] } });
  withReg('project-only', { version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'project', version: '1.2.5' }, { scope: 'local', version: '1.2.2' }] } });
  withReg('first-valid', { version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'local', version: 'bad' }, { scope: 'local', version: '1.2.5' }, { scope: 'local', version: '1.2.2' }] } });
  withReg('string-entry', { plugins: { 'anti-hall@anti-hall': '1.2.5' } });
  withReg('object-entry', { plugins: { 'anti-hall@anti-hall': { version: '1.2.5' } } });
  withReg('legacy-flat', { 'anti-hall@anti-hall': [{ version: '1.2.2', scope: 'user' }] });
  withReg('legacy-flat-string', { 'anti-hall@anti-hall': '1.2.5' });
  withReg('plugins-array', { plugins: [] });
  withReg('plugins-null', { plugins: null, 'anti-hall@anti-hall': '1.2.5' });
  withReg('other-plugin-only', { plugins: { 'other@x': [{ version: '9.9.9', scope: 'user' }] } });
  withReg('entry-null', { plugins: { 'anti-hall@anti-hall': null } });
  withReg('entry-number', { plugins: { 'anti-hall@anti-hall': 5 } });
  withReg('entry-empty-array', { plugins: { 'anti-hall@anti-hall': [] } });
  withReg('entry-array-of-junk', { plugins: { 'anti-hall@anti-hall': [null, 5, 'x', [], { version: 3 }] } });
  withReg('top-array', '[]'); withReg('top-null', 'null'); withReg('top-string', '"1.2.5"'); withReg('malformed', '{"plugins":'); withReg('empty', ''); withReg('bom', '﻿' + q(regv('1.2.5', 'user')));
  withReg('surrogate', '{"plugins":{"anti-hall@anti-hall":"\\ud800"}}', { expectDefer: true });
  withReg('oversize', q(regv('1.2.5', 'user')).slice(0, -1) + ',"pad":"' + 'x'.repeat(4 * 1024 * 1024 + 10) + '"}');
  withReg('just-under-size', q(regv('1.2.5', 'user')).slice(0, -1) + ',"pad":"' + 'x'.repeat(4 * 1024 * 1024 - 200) + '"}');
  add('registry-is-dir', merge(dirs('v1.2.4'), { ['home/' + REG + '/x']: '' }));
  add('registry-with-changelog', merge(dirs('v1.2.4'), H(MIR + 'v1.2.4/CHANGELOG.md', logs.standard), H(REG, q(regv('1.2.3', 'user')))));
  add('registry-ahead-with-changelog', merge(dirs('v1.2.4'), H(MIR + 'v1.2.4/CHANGELOG.md', logs.standard), H(REG, q(regv('1.2.9', 'user')))));
  // marketplace override: honoured only for an absolute path to an existing directory
  const mk = rel => ({ ['home/mk/' + rel]: '' });
  const alt = merge(dirs('v1.2.4'), mk('marketplaces/anti-hall/'), H('mk/installed_plugins.json', q(regv('1.2.3', 'user'))), H(REG, q(regv('1.2.5', 'user'))));
  add('marketplace-override-abs', alt, { env: { ANTIHALL_MARKETPLACE_DIR: '{{HOME}}/mk/marketplaces/anti-hall' } });
  add('marketplace-override-trailing-slash', alt, { env: { ANTIHALL_MARKETPLACE_DIR: '{{HOME}}/mk/marketplaces/anti-hall/' } });
  add('marketplace-override-relative', alt, { env: { ANTIHALL_MARKETPLACE_DIR: 'mk/marketplaces/anti-hall' } });
  add('marketplace-override-relative-from-cwd', merge(alt, H('mk2/marketplaces/anti-hall/', ''), H('mk2/installed_plugins.json', q(regv('1.2.3', 'user')))), { cwd: '{{HOME}}', env: { ANTIHALL_MARKETPLACE_DIR: 'mk/marketplaces/anti-hall' } });
  add('marketplace-override-missing', alt, { env: { ANTIHALL_MARKETPLACE_DIR: '{{HOME}}/nope' } });
  add('marketplace-override-file', merge(alt, H('mk/afile', 'x')), { env: { ANTIHALL_MARKETPLACE_DIR: '{{HOME}}/mk/afile' } });
  add('marketplace-override-empty', alt, { env: { ANTIHALL_MARKETPLACE_DIR: '' } });
  add('marketplace-override-symlink-dir', merge(alt, { 'home/mklink': { link: '{{HOME}}/mk/marketplaces/anti-hall' } }), { env: { ANTIHALL_MARKETPLACE_DIR: '{{HOME}}/mklink' } });
  add('marketplace-override-shallow', alt, { env: { ANTIHALL_MARKETPLACE_DIR: '{{HOME}}/mk' } });

  // the once-per-session marker of the reload advisory
  const mkey = (sid, mirrored, running) => `{"case":"reload","sessionId":${q(sid)},"mirrored":${q(mirrored || 'v1.2.4')},"running":${q(running || RUN)}}`;
  const mark = (id, text, extra) => add('marker-' + id, merge(dirs('v1.2.4'), H(MARK, text)), extra);
  const mrk = (la, rest) => `{${rest || ''}"checkedAt":${off(-HOUR)},"lastAdvised":${la}}`;
  mark('match', mrk(mkey('sess-1'))); mark('other-session', mrk(mkey('sess-2'))); mark('other-mirrored', mrk(mkey('sess-1', 'v1.2.9'))); mark('other-running', mrk(mkey('sess-1', 'v1.2.4', '1.0.0')));
  mark('match-no-session-id', mrk(mkey('sess-1')), { payload: { session_id: undefined } }); mark('match-extra-fields', mrk(mkey('sess-1'), '"keep":{"a":1,"b":[1,2]},'));
  mark('match-empty-session-no-dedupe', mrk(mkey('')), { payload: { session_id: undefined } });
  mark('match-empty-session-string-no-dedupe', mrk(mkey('')), { payload: { session_id: '' } });
  mark('no-checkedAt', `{"lastAdvised":${mkey('sess-1')}}`); mark('checkedAt-string', `{"checkedAt":"x","lastAdvised":${mkey('sess-1')}}`);
  mark('array', '[]'); mark('null', 'null'); mark('empty', ''); mark('malformed', '{'); mark('empty-object', '{}'); mark('no-lastAdvised', `{"checkedAt":${off(-HOUR)}}`);
  mark('lastAdvised-array', mrk('[]')); mark('lastAdvised-string', mrk('"x"')); mark('lastAdvised-update-case', mrk(key('sess-1')));
  mark('surrogate', '{"checkedAt":' + off(-HOUR) + ',"x":"\\ud800"}', { expectDefer: true });
  add('marker-absent-fresh-session', dirs('v1.2.4'), { payload: { session_id: 'brand-new' } });
  add('marker-absent-no-session', dirs('v1.2.4'), { payload: { session_id: undefined } });
  add('marker-dir-blocks-write', merge(dirs('v1.2.4'), { ['home/' + MARK + '/x']: '' }));
  add('state-dir-is-file', merge(dirs('v1.2.4'), { 'home/.anti-hall': 'x' }), { bare: true });
  add('two-sessions-same-marker', merge(dirs('v1.2.4'), H(MARK, mrk(mkey('sess-1')))), { payload: { session_id: 'sess-1' } });

  out.push(...switchMatrix(hook, { files: dirs('v1.2.4'), extra: { plugin: plug(RUN) } },
    { section: 'versionAlerts', key: 'antiHall', env: ['ANTIHALL_VERSION_ALERT'], option: 'version_alerts_anti_hall', guard: 'version-alert' }));
  out.push(...switchMatrix(hook, { files: H(CHECK, rc(q('1.2.4'))), extra: { plugin: plug(RUN) } },
    { section: 'versionAlerts', key: 'antiHall', env: ['ANTIHALL_VERSION_ALERT'], option: 'version_alerts_anti_hall', guard: 'version-alert' }).map(s => Object.assign(s, { id: s.id + '-remote' })));
  return out;
};
