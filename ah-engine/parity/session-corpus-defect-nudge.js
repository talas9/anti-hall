// defect-nudge scenarios (see session-corpus.js): a defect store under the home directory, a project directory that is (the
// maintainer's view) or is not the anti-hall repository, and the once-a-day stamp.
exports.build = function (ctx, h) {
  const { H, P, merge, off, HOUR, DAY, switchMatrix } = h;
  const out = [];
  const hook = 'defect-nudge';
  const q = JSON.stringify;
  const D = '.anti-hall/defects/';
  const STAMP = '.anti-hall/.defects-nudge-stamp.json';
  const MARKER = P('plugins/anti-hall/.claude-plugin/plugin.json', '{}');
  const iso = days => `{{ISO-${Math.round(days * DAY)}}}`;           // days ago (use .5 so a day boundary is never close)
  const rep = (o) => q(Object.assign({ t: 'report', proj: 'proj', sid: 's1', class: 'guard-miss', sev: 'p1', v: '1.0.0', at: iso(3.5) }, o));
  const rul = (o) => q(Object.assign({ t: 'ruling', status: 'ack', at: iso(2.5) }, o));
  const file = (name, ...lines) => H(D + name + '.jsonl', lines.join('\n') + '\n');
  const add = (id, files, extra) => out.push(Object.assign({ id: `${hook}-${id}`, hook, files: files || {} }, extra || {}));
  const maint = (id, files, extra) => add('maint-' + id, merge(MARKER, files), extra);
  const rptr = (id, files, extra) => add('rptr-' + id, files, extra);

  // ---- the maintainer's view ----------------------------------------------------------------------------------------------
  maint('no-store', {});
  maint('empty-store', { ['home/' + D]: '' });
  maint('one-open', file('aaaaaaaaaaaa', rep()));
  maint('one-open-oldest-days', file('aaaaaaaaaaaa', rep({ at: iso(11.5) })));
  maint('many-open', merge(...Array.from({ length: 50 }, (_, i) => file('f' + String(i).padStart(11, '0'), rep({ at: iso(1.5 + i * 0.7) })))));
  for (const st of ['open', 'ack', 'partial', 'fixed', 'wontfix', 'notabug', 'dup', 'FIXED', 'weird', '', 'regressed', 'Fixed '])
    maint('status-' + JSON.stringify(st), file('aaaaaaaaaaaa', rep(), rul({ status: st })));
  maint('status-non-string', file('aaaaaaaaaaaa', rep(), rul({ status: 5 })));
  maint('status-null', file('aaaaaaaaaaaa', rep(), rul({ status: null })));
  maint('status-last-wins', file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed' }), rul({ status: 'ack' })));
  maint('status-last-wins-closed', file('aaaaaaaaaaaa', rep(), rul({ status: 'ack' }), rul({ status: 'dup' })));
  maint('only-closed', merge(file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed' })), file('bbbbbbbbbbbb', rep(), rul({ status: 'wontfix' }))));
  maint('mixed', merge(file('aaaaaaaaaaaa', rep({ at: iso(20.5) }), rul({ status: 'fixed' })), file('bbbbbbbbbbbb', rep({ at: iso(9.5) })), file('cccccccccccc', rep({ at: iso(30.5) }), rul({ status: 'partial' }))));
  // the regression cycle: a report at or after the fix reopens it
  const rg = (id, fixedIn, v, extra) => maint('regress-' + id, file('aaaaaaaaaaaa', rep({ at: iso(9.5) }), rul({ status: 'fixed', fixedIn, at: iso(8.5) }), rep({ v, at: iso(1.5) })), extra);
  rg('after', '1.0.0', '1.0.1'); rg('equal', '1.0.0', '1.0.0'); rg('before', '1.0.1', '1.0.0'); rg('minor', '1.0.9', '1.1.0'); rg('major-before', '2.0.0', '1.9.9');
  rg('v-prefixed', 'v1.0.0', 'v1.0.1'); rg('two-part', '1.0', '1.0.1'); rg('unparseable-v', '1.0.0', 'x'); rg('unparseable-fixed', 'x', '1.0.0'); rg('big', '1.0.0', '99999999999999999999.0.0');
  rg('spaces', ' 1.0.0 ', ' 1.0.1 '); rg('empty-fixedIn', '', '1.0.1'); rg('four-part', '1.0.0', '1.0.0.1'); rg('prerelease', '1.0.0', '1.0.1-beta');
  maint('regress-non-string-fixedIn', file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed', fixedIn: 5 }), rep({ v: '9.9.9' })));
  maint('regress-non-string-v', file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed', fixedIn: '1.0.0' }), rep({ v: 5 })));
  maint('regress-then-ruling-clears', file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed', fixedIn: '1.0.0' }), rep({ v: '1.0.1' }), rul({ status: 'fixed', fixedIn: '1.0.1' })));
  maint('regress-then-ruling-ack', file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed', fixedIn: '1.0.0' }), rep({ v: '1.0.1' }), rul({ status: 'ack' })));
  maint('regress-repeat', file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed', fixedIn: '1.0.0' }), rep({ v: '1.0.1' }), rep({ v: '0.9.0' })));
  maint('regress-two-files', merge(file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed', fixedIn: '1.0.0' }), rep({ v: '1.0.1' })), file('bbbbbbbbbbbb', rep(), rul({ status: 'fixed', fixedIn: '1.0.0' }), rep({ v: '1.0.1' }))));
  maint('backfill-fixed', file('aaaaaaaaaaaa', q({ t: 'backfill', status: 'fixed', at: iso(40.5) })));
  maint('backfill-open', file('aaaaaaaaaaaa', q({ t: 'backfill', status: 'open', at: iso(40.5) })));
  maint('backfill-no-status', file('aaaaaaaaaaaa', q({ t: 'backfill', at: iso(40.5) })));
  maint('backfill-then-report-regress', file('aaaaaaaaaaaa', q({ t: 'backfill', status: 'fixed', at: iso(40.5) }), rep()));
  maint('unknown-type', file('aaaaaaaaaaaa', q({ t: 'note', status: 'fixed', at: iso(5.5) })));
  maint('no-type', file('aaaaaaaaaaaa', q({ status: 'fixed', at: iso(5.5) })));
  maint('type-non-string', file('aaaaaaaaaaaa', q({ t: 5, status: 'fixed', at: iso(5.5) })));
  // dates (firstSeen is the first line that has one)
  for (const [id, at] of [['no-at', undefined], ['empty-at', ''], ['number-at', 5], ['null-at', null], ['date-only', '2026-09-01'], ['no-ms', '2026-09-01T10:20:30Z'], ['ms', '2026-09-01T10:20:30.123Z'],
    ['future', '2999-01-01T00:00:00.000Z'], ['epoch', '1970-01-01T00:00:00.000Z']]) maint('at-' + id, file('aaaaaaaaaaaa', JSON.stringify({ t: 'report', proj: 'proj', v: '1.0.0', at })));
  for (const [id, at] of [['space-sep', '2026-09-01 10:20:30'], ['local-time', '2026-09-01T10:20:30'], ['offset', '2026-09-01T10:20:30+02:00'], ['words', 'March 3, 2026'], ['garbage', 'not a date'], ['rfc', 'Tue, 01 Sep 2026 10:20:30 GMT'],
    ['month-13', '2026-13-01'], ['feb-30', '2026-02-30'], ['hour-25', '2026-09-01T25:00:00Z'], ['micro', '2026-09-01T10:20:30.123456Z'], ['year-only', '2026'], ['slash', '2026/09/01'], ['leading-space', ' 2026-09-01']])
    maint('at-' + id, file('aaaaaaaaaaaa', JSON.stringify({ t: 'report', proj: 'proj', v: '1.0.0', at })), { expectDefer: true });
  maint('first-dated-line-wins', file('aaaaaaaaaaaa', q({ t: 'report', proj: 'proj' }), rep({ at: iso(7.5) }), rep({ at: iso(2.5) })));
  maint('oldest-across-files', merge(file('aaaaaaaaaaaa', rep({ at: iso(2.5) })), file('bbbbbbbbbbbb', rep({ at: iso(14.5) })), file('cccccccccccc', rep({ at: iso(5.5) }))));
  maint('closed-old-ignored-for-oldest', merge(file('aaaaaaaaaaaa', rep({ at: iso(300.5) }), rul({ status: 'fixed' })), file('bbbbbbbbbbbb', rep({ at: iso(2.5) }))));
  // damaged and odd files
  maint('torn-line', file('aaaaaaaaaaaa', rep(), '{"t":"report","proj"'));
  maint('torn-only', file('aaaaaaaaaaaa', '{"t":"rep'));
  maint('blank-lines', H(D + 'aaaaaaaaaaaa.jsonl', '\n\n' + rep() + '\n\n\n'));
  maint('crlf', H(D + 'aaaaaaaaaaaa.jsonl', rep() + '\r\n' + rul({ status: 'fixed' }) + '\r\n'));
  maint('cr-only-line', H(D + 'aaaaaaaaaaaa.jsonl', rep() + '\n\r\n' + rul({ status: 'dup' }) + '\n'));
  maint('no-trailing-newline', H(D + 'aaaaaaaaaaaa.jsonl', rep()));
  maint('bom', H(D + 'aaaaaaaaaaaa.jsonl', '﻿' + rep() + '\n'));
  maint('array-lines', H(D + 'aaaaaaaaaaaa.jsonl', '[1,2]\n' + rep() + '\n"str"\n5\nnull\ntrue\n'));
  maint('nested-garbage', H(D + 'aaaaaaaaaaaa.jsonl', rep() + '\n{"t":{"x":[1,{"y":null}]}}\n'));
  maint('surrogate-line', H(D + 'aaaaaaaaaaaa.jsonl', rep({ note: 'X' }).replace('"X"', '"\\ud800"') + '\n'), { expectDefer: true });
  maint('surrogate-pair-ok', H(D + 'aaaaaaaaaaaa.jsonl', rep({ note: '😀' }) + '\n'));
  maint('invalid-utf8', H(D + 'aaaaaaaaaaaa.jsonl', Buffer.concat([Buffer.from(rep() + '\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(rul({ status: 'dup' }) + '\n')])));
  maint('huge-line', H(D + 'aaaaaaaaaaaa.jsonl', rep({ note: 'x'.repeat(2000000) }) + '\n'));
  maint('unicode-fields', file('aaaaaaaaaaaa', rep({ proj: 'é日本😀', sym: 'ü' })));
  maint('non-jsonl-ignored', merge(H(D + 'aaaaaaaaaaaa.json', rep()), H(D + 'notes.txt', rep()), H(D + 'x.jsonl.bak', rep())));
  maint('dotfile-jsonl', H(D + '.jsonl', rep() + '\n'));
  maint('dir-named-jsonl', { ['home/' + D + 'adir.jsonl/x']: '' });
  maint('archive-ignored', merge(file('aaaaaaaaaaaa', rep()), H(D + 'archive/2026-08/bbbbbbbbbbbb.jsonl', rep()), H(D + 'history/cccccccccccc.jsonl', rep())));
  maint('symlink-file', merge(H('real/x.jsonl', rep() + '\n'), { ['home/' + D + 'aaaaaaaaaaaa.jsonl']: { link: '{{HOME}}/real/x.jsonl' } }));
  maint('dangling-symlink', { ['home/' + D + 'aaaaaaaaaaaa.jsonl']: { link: '{{HOME}}/nowhere' } });
  maint('unreadable-file-counts-open', H(D + 'aaaaaaaaaaaa.jsonl', { content: rep() + '\n', mode: 0 }));
  maint('store-is-file', H('.anti-hall/defects', 'x'));
  maint('uppercase-ext-ignored', H(D + 'aaaaaaaaaaaa.JSONL', rep() + '\n'));
  maint('double-ext', H(D + 'a.jsonl.jsonl', rep() + '\n'));
  maint('long-name', file('x'.repeat(200), rep()));
  maint('unicode-name', file('é日本', rep()));

  // ---- the reporter's view ----------------------------------------------------------------------------------------------------
  rptr('no-store', {});
  rptr('own-report-no-ruling', file('aaaaaaaaaaaa', rep()));
  rptr('own-report-then-ruling', file('aaaaaaaaaaaa', rep(), rul()));
  rptr('ruling-before-own-report', file('aaaaaaaaaaaa', rul(), rep()));
  rptr('other-proj-report-ruling', file('aaaaaaaaaaaa', rep({ proj: 'other' }), rul()));
  rptr('own-then-other-then-ruling', file('aaaaaaaaaaaa', rep(), rep({ proj: 'other' }), rul()));
  rptr('other-then-own-then-ruling', file('aaaaaaaaaaaa', rep({ proj: 'other' }), rep(), rul()));
  rptr('own-ruling-own', file('aaaaaaaaaaaa', rep(), rul(), rep()));
  rptr('two-rulings', file('aaaaaaaaaaaa', rep(), rul(), rul({ status: 'fixed' })));
  rptr('three-files', merge(file('aaaaaaaaaaaa', rep(), rul()), file('bbbbbbbbbbbb', rep(), rul({ status: 'fixed' })), file('cccccccccccc', rep())));
  rptr('many-files', merge(...Array.from({ length: 40 }, (_, i) => file('f' + String(i).padStart(11, '0'), rep(), i % 3 ? rul() : rep()))));
  rptr('proj-non-string', file('aaaaaaaaaaaa', rep({ proj: 5 }), rul()));
  rptr('proj-case', file('aaaaaaaaaaaa', rep({ proj: 'PROJ' }), rul()));
  rptr('proj-trailing-space', file('aaaaaaaaaaaa', rep({ proj: 'proj ' }), rul()));
  rptr('status-closed-still-counts', file('aaaaaaaaaaaa', rep(), rul({ status: 'fixed' })));
  rptr('ruling-type-only', file('aaaaaaaaaaaa', rep(), q({ t: 'ruling' })));
  rptr('torn-then-ruling', file('aaaaaaaaaaaa', rep(), '{"t":"rul', rul()));
  rptr('array-between', H(D + 'aaaaaaaaaaaa.jsonl', rep() + '\n[1]\n' + rul() + '\n'));
  rptr('backfill-not-ruling', file('aaaaaaaaaaaa', rep(), q({ t: 'backfill', status: 'fixed' })));
  rptr('unicode-proj', file('aaaaaaaaaaaa', rep({ proj: 'é日本' }), rul()), { payload: { cwd: '{{BASE}}/é日本' }, git: undefined, files2: undefined });
  out.pop();
  add('rptr-unicode-proj', merge(file('aaaaaaaaaaaa', rep({ proj: 'é日本' }), rul()), P('keep', '')), { payload: { cwd: '{{BASE}}/é日本' } });
  add('rptr-cwd-trailing-slash', file('aaaaaaaaaaaa', rep(), rul()), { payload: { cwd: '{{PROJ}}/' } });
  add('rptr-cwd-double-slash', file('aaaaaaaaaaaa', rep(), rul()), { payload: { cwd: '{{PROJ}}//' } });
  add('rptr-cwd-dotdot', file('aaaaaaaaaaaa', rep(), rul()), { payload: { cwd: '{{PROJ}}/../proj' } });
  add('rptr-cwd-root', file('aaaaaaaaaaaa', rep({ proj: '' }), rul()), { payload: { cwd: '/' } });
  add('rptr-cwd-nonexistent', file('aaaaaaaaaaaa', rep({ proj: 'gone' }), rul()), { payload: { cwd: '{{BASE}}/gone' } });
  add('rptr-cwd-is-marker-nested', merge(file('aaaaaaaaaaaa', rep(), rul()), P('sub/plugins/anti-hall/.claude-plugin/plugin.json', '{}')));
  // fallbacks of showDefect: the listed name does not open (dangling link): the archive months, then the history copy
  const dangling = fp => ({ ['home/' + D + fp + '.jsonl']: { link: '{{HOME}}/nowhere' } });
  rptr('dangling-archive-found', merge(dangling('aaaaaaaaaaaa'), H(D + 'archive/2026-08/aaaaaaaaaaaa.jsonl', rep() + '\n' + rul() + '\n')));
  rptr('dangling-archive-second-month', merge(dangling('aaaaaaaaaaaa'), H(D + 'archive/2026-07/aaaaaaaaaaaa.jsonl', rep() + '\n'), H(D + 'archive/2026-08/aaaaaaaaaaaa.jsonl', rep() + '\n' + rul() + '\n')));
  rptr('dangling-history-found', merge(dangling('aaaaaaaaaaaa'), H(D + 'history/aaaaaaaaaaaa.jsonl', rep() + '\n' + rul() + '\n')));
  rptr('dangling-archive-beats-history', merge(dangling('aaaaaaaaaaaa'), H(D + 'archive/2026-08/aaaaaaaaaaaa.jsonl', rep() + '\n'), H(D + 'history/aaaaaaaaaaaa.jsonl', rep() + '\n' + rul() + '\n')));
  rptr('dangling-nowhere', dangling('aaaaaaaaaaaa'));
  rptr('dangling-archive-is-file', merge(dangling('aaaaaaaaaaaa'), H(D + 'archive', 'x')));

  // ---- the once-a-day stamp ----------------------------------------------------------------------------------------------------
  const one = merge(MARKER, file('aaaaaaaaaaaa', rep()));
  const stamp = (id, text, extra) => add('stamp-' + id, merge(one, H(STAMP, text)), extra);
  add('stamp-absent', one);
  stamp('fresh', `{"lastSweep":${off(-HOUR)}}`); stamp('stale', `{"lastSweep":${off(-DAY - 10000)}}`); stamp('edge-in', `{"lastSweep":${off(-DAY + 10000)}}`);
  stamp('future', `{"lastSweep":${off(HOUR)}}`); stamp('zero', '{"lastSweep":0}'); stamp('negative', '{"lastSweep":-5}'); stamp('string', '{"lastSweep":"x"}'); stamp('null', '{"lastSweep":null}');
  stamp('missing', '{}'); stamp('array', '[]'); stamp('number', '5'); stamp('malformed', '{"lastSweep":'); stamp('empty', ''); stamp('blank', '  \n ');
  stamp('nbsp-wrapped', ` {"lastSweep":${off(-HOUR)}} `); stamp('feff-wrapped', `﻿{"lastSweep":${off(-HOUR)}}`); stamp('extra-fields', `{"x":1,"lastSweep":${off(-HOUR)}}`);
  stamp('float', `{"lastSweep":${off(-HOUR)}.5}`); stamp('1e999', '{"lastSweep":1e999}', { expectDefer: true }); stamp('surrogate', `{"lastSweep":${off(-HOUR)},"x":"\\ud800"}`, { expectDefer: true });
  add('stamp-dir', merge(one, { ['home/' + STAMP + '/x']: '' }));
  add('stamp-unwritable-dir', merge(MARKER, { 'home/.anti-hall': 'x' }), { bare: true });
  add('stamp-written-when-silent', merge(MARKER, H(STAMP, '{"lastSweep":1}')));
  add('stamp-written-no-defects', MARKER);
  add('stamp-bare-home', merge(MARKER, file('aaaaaaaaaaaa', rep())), { bare: true });

  // ---- payloads ---------------------------------------------------------------------------------------------------------------
  const base = one;
  add('payload-no-cwd', base, { payload: { cwd: undefined }, expectDefer: true });
  add('payload-empty-cwd', base, { payload: { cwd: '' }, expectDefer: true });
  add('payload-number-cwd', base, { payload: { cwd: 5 }, expectDefer: true });
  add('payload-relative-cwd', base, { payload: { cwd: 'proj' }, expectDefer: true });
  add('payload-dot-cwd', base, { payload: { cwd: '.' }, expectDefer: true });
  add('payload-tilde-cwd', base, { payload: { cwd: '~/proj' }, expectDefer: true });
  add('payload-malformed', base, { raw: '{', expectDefer: true });
  add('payload-empty', base, { raw: '', expectDefer: true });
  add('payload-array', base, { raw: '[]', expectDefer: true });
  add('payload-other-event', base, { payload: { hook_event_name: 'Stop' }, expectDefer: true });
  add('payload-extra-fields', base, { payload: { source: 'startup', model: 'x', junk: { a: [1, 2] } } });
  add('payload-no-session', base, { payload: { session_id: undefined } });
  add('payload-subagent', base, { payload: { agent_id: 'a' } });
  out.push(...switchMatrix(hook, { files: one }, { section: 'context', key: 'defectNudge', env: [], option: 'context_defect_nudge', guard: 'defect-nudge' }));
  return out;
};
