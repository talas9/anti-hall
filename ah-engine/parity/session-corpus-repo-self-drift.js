// repo-self-drift scenarios (see session-corpus.js). The plugin root is a real copy per variant; docs/KB.md is written into
// it (installed layout) or above it (repository layout), and extra hook files or skill directories change the counts on disk.
const fs = require('fs'), path = require('path');
exports.build = function (ctx, h) {
  const { H, merge, off, HOUR, DAY, switchMatrix } = h;
  const out = [];
  const hook = 'repo-self-drift';
  const CACHE = '.anti-hall/repo-self-drift.json';
  const q = JSON.stringify;
  const hooksDir = path.join(ctx.repo, 'plugins', 'anti-hall', 'hooks');
  const realHooks = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js')).length;
  const realSkills = 1; // the harness copies only skills/update
  const kb = (hooks, skills, pre, mid) => `# KB\n\n${pre || ''}- Hooks: **${hooks}** \`.js\` files\n${mid || ''}- Claude\n> skills: **${skills}**\n`;
  const add = (id, plugin, files, extra) => out.push(Object.assign({ id: `${hook}-${id}`, hook, plugin: plugin || {}, files: files || {} }, extra || {}));
  const ok = kb(realHooks, realSkills);

  // ---- the scan: claimed counts against the files on disk -------------------------------------------------------------
  add('counts-match', { kbInstalled: ok });
  add('hooks-off', { kbInstalled: kb(realHooks + 3, realSkills) });
  add('skills-off', { kbInstalled: kb(realHooks, realSkills + 4) });
  add('both-off', { kbInstalled: kb(1, 2) });
  add('extra-hook-files', { kbInstalled: ok, extraHooks: ['aa.js', 'bb.js'] });
  add('extra-hook-files-claimed', { kbInstalled: kb(realHooks + 2, realSkills), extraHooks: ['aa.js', 'bb.js'] });
  add('extra-skill-dirs', { kbInstalled: ok, skillDirs: ['a', 'b', 'c'] });
  add('extra-skill-dirs-claimed', { kbInstalled: kb(realHooks, realSkills + 3), skillDirs: ['a', 'b', 'c'] });
  add('skill-files-not-counted', { kbInstalled: kb(realHooks, realSkills), skillFiles: ['x.md', 'y.md'] });
  add('skill-symlink-not-counted', { kbInstalled: kb(realHooks, realSkills), skillLinks: { lnk: '/tmp' } });
  add('hooks-removed', { kbInstalled: kb(realHooks - 2, realSkills), removeHooks: ['git-guard.js', 'edit-guard.js'] });
  add('non-js-extras-not-counted', { kbInstalled: ok, extraHooks: ['x.json', 'y.md', 'z.js.bak', 'w.mjs', 'v.JS'] });
  add('no-kb', {});
  add('kb-empty', { kbInstalled: '' });
  add('kb-no-claims', { kbInstalled: '# KB\n\nnothing to see\n' });
  add('kb-only-hooks-claim', { kbInstalled: `- Hooks: **${realHooks}** \`.js\` files\n` });
  add('kb-only-skills-claim', { kbInstalled: `- Claude\n> skills: **${realSkills}**\n` });
  add('kb-dir-not-file', { kbInstalledDir: true });
  add('kb-repo-layout', { kbRepo: ok });
  add('kb-repo-layout-off', { kbRepo: kb(2, 2) });
  add('kb-both-installed-wins', { kbInstalled: kb(2, 2), kbRepo: ok });
  add('kb-both-installed-empty-wins', { kbInstalled: '', kbRepo: kb(2, 2) });
  add('kb-dir-and-repo', { kbInstalledDir: true, kbRepo: kb(2, 2) });
  // the claim patterns
  const claims = {
    'skills-same-line': `- Hooks: **${realHooks + 1}** \`.js\` files\nClaude skills: **${realSkills}**\n`,
    'skills-newline': `- Hooks: **${realHooks + 1}** \`.js\` files\nClaude\nskills: **${realSkills}**\n`,
    'skills-newline-quote': `- Hooks: **${realHooks + 1}** \`.js\` files\nClaude\n>skills: **${realSkills}**\n`,
    'skills-quote-spaces': `- Hooks: **${realHooks + 1}** \`.js\` files\nClaude \n> skills: **${realSkills}**\n`,
    'skills-two-newlines': `- Hooks: **${realHooks + 1}** \`.js\` files\nClaude\n\nskills: **${realSkills}**\n`,
    'skills-crlf': `- Hooks: **${realHooks + 1}** \`.js\` files\r\nClaude\r\n> skills: **${realSkills}**\r\n`,
    'skills-nbsp': `- Hooks: **${realHooks + 1}** \`.js\` files\nClaude skills: **${realSkills}**\n`,
    'skills-feff': `- Hooks:﻿**${realHooks + 1}** \`.js\` files\nClaude﻿skills: **${realSkills}**\n`,
    'skills-nel': `- Hooks:\u0085**${realHooks + 1}** \`.js\` files\n`,
    'no-space': `- Hooks:**${realHooks + 1}**\`.js\`files\n`,
    'lowercase': `- hooks: **${realHooks + 1}** \`.js\` files\n`,
    'bold-spaces': `- Hooks: ** ${realHooks + 1} ** \`.js\` files\n`,
    'plain-digits': `- Hooks: ${realHooks + 1} \`.js\` files\n`,
    'leading-zeros': `- Hooks: **00${realHooks + 1}** \`.js\` files\nClaude skills: **00${realSkills}**\n`,
    'first-wins': `- Hooks: **${realHooks + 1}** \`.js\` files\n- Hooks: **9** \`.js\` files\nClaude skills: **${realSkills}**\nClaude skills: **99**\n`,
    'arabic-digits': `- Hooks: **٤٩** \`.js\` files\n`,
    'sixteen-digits': `- Hooks: **${'1'.repeat(16)}** \`.js\` files\nClaude skills: **${realSkills}**\n`,
    'fifteen-digits': `- Hooks: **${'1'.repeat(15)}** \`.js\` files\nClaude skills: **${realSkills}**\n`,
    'huge-digits': `- Hooks: **${'9'.repeat(400)}** \`.js\` files\n`,
    'skills-sixteen': `- Hooks: **${realHooks}** \`.js\` files\nClaude skills: **${'2'.repeat(16)}**\n`,
    'zero': `- Hooks: **0** \`.js\` files\nClaude skills: **0**\n`,
    'html-ish': `<p>Hooks: **${realHooks + 1}** \`.js\` files</p>`,
    'quoted-twice': `> Hooks: **${realHooks + 1}** \`.js\` files\n> Claude\n> > skills: **${realSkills}**\n`,
  };
  for (const [id, text] of Object.entries(claims)) add('claim-' + id, { kbInstalled: text }, {}, ['sixteen-digits', 'huge-digits', 'skills-sixteen'].includes(id) ? { expectDefer: true } : undefined);

  // ---- the cache -------------------------------------------------------------------------------------------------------
  const cacheText = (o, checkedAt) => `{"checkedAt":${checkedAt === undefined ? off(-HOUR) : checkedAt}${o ? ',' + o : ''}}`;
  const full = (ch, ah, cs, as, age, date, rest) => cacheText(`"claimedHooks":${ch},"actualHooks":${ah},"claimedSkills":${cs},"actualSkills":${as},"modelKbAuditDate":${date === undefined ? '"2026-09-03"' : date},"modelKbAgeDays":${age === undefined ? 34 : age}${rest ? ',' + rest : ''}`);
  const withCache = (id, text, plugin, extra) => add(id, plugin || { kbInstalled: ok }, H(CACHE, text), extra);
  withCache('fresh-match', full(49, 49, 15, 15));
  withCache('fresh-hooks-off', full(50, 49, 15, 15));
  withCache('fresh-skills-off', full(49, 49, 16, 15));
  withCache('fresh-both-off', full(50, 49, 16, 15));
  withCache('fresh-stale-model', full(49, 49, 15, 15, 100));
  withCache('fresh-stale-model-and-counts', full(50, 49, 15, 15, 100));
  withCache('fresh-age-60-not-stale', full(49, 49, 15, 15, 60));
  withCache('fresh-age-61-stale', full(49, 49, 15, 15, 61));
  withCache('fresh-age-float', full(49, 49, 15, 15, 61.5));
  withCache('fresh-age-string', full(49, 49, 15, 15, '"100"'));
  withCache('fresh-age-null', full(49, 49, 15, 15, 'null'));
  withCache('fresh-age-negative', full(49, 49, 15, 15, -5));
  withCache('fresh-age-huge', full(49, 49, 15, 15, '1e300'));
  withCache('fresh-age-1e21', full(49, 49, 15, 15, '1e21'));
  withCache('fresh-age-1e999', full(49, 49, 15, 15, '1e999'), undefined, { expectDefer: true });
  withCache('fresh-date-number', full(49, 49, 15, 15, 100, '20260903'));
  withCache('fresh-date-null', full(49, 49, 15, 15, 100, 'null'));
  withCache('fresh-date-true', full(49, 49, 15, 15, 100, 'true'));
  withCache('fresh-date-object', full(49, 49, 15, 15, 100, '{"a":1}'), undefined, { expectDefer: true });
  withCache('fresh-date-array', full(49, 49, 15, 15, 100, '[1,2]'), undefined, { expectDefer: true });
  withCache('fresh-date-missing', cacheText('"modelKbAgeDays":100'), undefined, { expectDefer: true });
  withCache('fresh-date-unicode', full(49, 49, 15, 15, 100, q('é"\n日本')));
  withCache('fresh-date-spaces', full(49, 49, 15, 15, 100, q('  a   b  ')));
  withCache('fresh-counts-null', full('null', 49, 15, 15, 100));
  withCache('fresh-counts-string', full('"49"', '"50"', 15, 15, 100));
  withCache('fresh-actual-null', full(49, 'null', 15, 'null', 100));
  withCache('fresh-claimed-float', full(49.5, 49, 15, 15));
  withCache('fresh-counts-negative', full(-1, 49, 15, 15));
  withCache('fresh-counts-huge', full('1e300', 49, 15, 15));
  withCache('fresh-counts-1e21', full('1e21', 1, 2, 3));
  withCache('fresh-no-fields', cacheText(''));
  withCache('fresh-only-age', cacheText('"modelKbAgeDays":100,"modelKbAuditDate":"2026-01-01"'));
  withCache('stale-rescan', full(1, 2, 3, 4, 100).replace(/"checkedAt":\{\{NOW-3600000\}\}/, `"checkedAt":${off(-2 * DAY)}`));
  withCache('stale-edge-out', cacheText('"claimedHooks":1', off(-DAY - 10000)));
  withCache('fresh-edge-in', cacheText(`"claimedHooks":50,"actualHooks":49,"claimedSkills":15,"actualSkills":15,"modelKbAuditDate":"2026-09-03","modelKbAgeDays":34`, off(-DAY + 10000)));
  withCache('future-rescan', full(50, 49, 15, 15, 100).replace(/"checkedAt":\{\{NOW-3600000\}\}/, `"checkedAt":${off(HOUR)}`));
  withCache('checkedAt-string', '{"checkedAt":"x","claimedHooks":50}');
  withCache('checkedAt-null', '{"checkedAt":null}');
  withCache('no-checkedAt', '{"claimedHooks":50}');
  for (const [id, t] of [['empty', ''], ['malformed', '{"checkedAt":'], ['array', '[]'], ['null', 'null'], ['string', '"x"'], ['bom', '﻿' + full(1, 2, 3, 4)], ['junk-after', full(1, 2, 3, 4) + 'x']]) withCache('cache-' + id, t);
  withCache('cache-surrogate', '{"checkedAt":' + off(-HOUR) + ',"x":"\\ud800"}', undefined, { expectDefer: true });
  add('absent-writes-scan', { kbInstalled: ok });
  add('absent-writes-scan-mismatch', { kbInstalled: kb(1, 1) });
  add('absent-no-kb', {});
  add('bare-home-mkdir', { kbInstalled: kb(1, 1) }, {}, { bare: true });
  add('cache-is-dir-write-fails', { kbInstalled: kb(1, 1) }, { ['home/' + CACHE + '/x']: '' });
  add('state-dir-is-file', { kbInstalled: kb(1, 1) }, { 'home/.anti-hall': 'x' }, { bare: true });
  add('cache-unreadable-rescan', { kbInstalled: kb(1, 1) }, H(CACHE, { content: full(1, 2, 3, 4), mode: 0 }));

  // ---- lastAdvised (the dedupe) ----------------------------------------------------------------------------------------
  const ck = (ch, ah, cs, as) => `{"claimedHooks":${ch},"actualHooks":${ah},"claimedSkills":${cs},"actualSkills":${as}}`;
  const sk = date => `{"modelKbAuditDate":${date}}`;
  const laCase = (id, la, ages, rest) => withCache('la-' + id, full(50, 49, 16, 15, ages === undefined ? 100 : ages, undefined, `"lastAdvised":${la}${rest ? ',' + rest : ''}`));
  laCase('counts-match', `{"counts":${ck(50, 49, 16, 15)}}`);
  laCase('counts-match-reordered', `{"counts":{"actualSkills":15,"claimedSkills":16,"actualHooks":49,"claimedHooks":50}}`);
  laCase('counts-other', `{"counts":${ck(51, 49, 16, 15)}}`);
  laCase('counts-extra-key', `{"counts":{"claimedHooks":50,"actualHooks":49,"claimedSkills":16,"actualSkills":15,"x":1}}`);
  laCase('counts-missing-key', `{"counts":{"claimedHooks":50,"actualHooks":49,"claimedSkills":16}}`);
  laCase('staleness-match', `{"staleness":${sk('"2026-09-03"')}}`);
  laCase('staleness-other', `{"staleness":${sk('"2026-01-01"')}}`);
  laCase('both-match', `{"counts":${ck(50, 49, 16, 15)},"staleness":${sk('"2026-09-03"')}}`);
  laCase('both-match-order', `{"staleness":${sk('"2026-09-03"')},"counts":${ck(50, 49, 16, 15)}}`);
  laCase('counts-only-staleness-new', `{"counts":${ck(50, 49, 16, 15)}}`);
  laCase('staleness-only-counts-new', `{"staleness":${sk('"2026-09-03"')}}`);
  laCase('keeps-other-keys', `{"zz":1,"counts":${ck(1, 2, 3, 4)},"yy":{"b":1}}`);
  laCase('empty-object', '{}');
  laCase('null', 'null'); laCase('false', 'false'); laCase('zero', '0'); laCase('empty-string', '""');
  // a lastAdvised that is truthy but not an object is read by JavaScript's Object.assign in ways this port does not copy: Node decides
  for (const [id, v] of [['array', '[]'], ['array-full', '[1]'], ['string', '"x"'], ['number', '5'], ['true', 'true']]) { laCase(id, v); out[out.length - 1].expectDefer = true; }
  laCase('counts-array', '{"counts":[]}'); laCase('counts-string', '{"counts":"x"}'); laCase('counts-null', '{"counts":null}');
  laCase('staleness-number-date', `{"staleness":${sk('20260903')}}`);
  withCache('la-counts-match-no-staleness-needed', full(50, 49, 16, 15, 10, undefined, `"lastAdvised":{"counts":${ck(50, 49, 16, 15)}}`));
  withCache('la-staleness-match-no-counts', full(49, 49, 15, 15, 100, undefined, `"lastAdvised":{"staleness":${sk('"2026-09-03"')}}`));
  withCache('la-all-advised-nothing-to-say', full(50, 49, 16, 15, 100, undefined, `"lastAdvised":{"counts":${ck(50, 49, 16, 15)},"staleness":${sk('"2026-09-03"')}}`));
  withCache('la-key-order-preserved', cacheText(`"zz":1,"lastAdvised":{"staleness":${sk('"x"')},"counts":${ck(1, 2, 3, 4)}},"claimedHooks":50,"actualHooks":49,"claimedSkills":16,"actualSkills":15,"modelKbAuditDate":"2026-09-03","modelKbAgeDays":100,"tail":[1,{"a":2}]`));
  withCache('la-nan-ish-numbers', full(50, 49, 16, 15, 100, undefined, `"lastAdvised":{"counts":{"claimedHooks":50.0,"actualHooks":49,"claimedSkills":16,"actualSkills":15}}`));

  // ---- payload shapes and switches -------------------------------------------------------------------------------------------
  add('payload-malformed', { kbInstalled: kb(1, 1) }, {}, { raw: '{', expectDefer: true });
  add('payload-empty', { kbInstalled: kb(1, 1) }, {}, { raw: '', expectDefer: true });
  add('payload-subagent', { kbInstalled: kb(1, 1) }, {}, { payload: { agent_id: 'x' } });
  add('payload-other-event', { kbInstalled: kb(1, 1) }, {}, { payload: { hook_event_name: 'Stop' }, expectDefer: true });
  out.push(...switchMatrix(hook, { files: H(CACHE, full(50, 49, 16, 15, 100)), extra: { plugin: { kbInstalled: ok } } },
    { section: 'guards', key: 'repoSelfDrift', env: ['ANTIHALL_REPO_SELF_DRIFT'], option: 'guards_repo_self_drift', guard: 'repo-self-drift' }));
  return out;
};
