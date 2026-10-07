// Seeded random scenarios for the session-maintenance parity run: state files whose fields hold random JSON of every type,
// in random order, sometimes cut short or padded with whitespace, around the values each hook really reads. The point is not
// realism but disagreement: any input the Node hook and the engine read differently shows up as a mismatch (or, for a text
// the engine cannot read exactly like JavaScript, as a deferral, which is correct and counted).
const rng = seed => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

exports.build = function (hook, h, seed, n) {
  const { H, P, merge, off, HOUR, DAY } = h;
  const R = rng(seed);
  const pick = a => a[Math.floor(R() * a.length)];
  const STR = ['', ' ', 'x', 'é', '日本', '😀', '\n', ' ', '﻿', ' ', '2.2.0', '2.1.238', 'v2.1.240', '1.2.4', '1.2', '1.2.3.4', '0.0.0', '99999999999999999999.1.0', '١.٢.٣', 'a b  c', '"q"', '\\', '{{', '}}', '\u0001', 'sess-1', '2026-09-01', '2026-09-01T10:20:30.123Z', 'fixed', 'open', 'report'];
  const NUM = [0, -0, 1, -1, 2, 5, 15, 49, 60, 61, 100, 1.5, 0.1, 1e21, 1e-7, 123456789012345680000, 9007199254740993, 1700000000000, 1e300];
  const rv = d => {
    const t = R();
    if (t < 0.28) return JSON.stringify(pick(STR));
    if (t < 0.5) return String(pick(NUM)).replace('e+', 'e+');
    if (t < 0.58) return 'null';
    if (t < 0.64) return 'true';
    if (t < 0.7) return 'false';
    if (d > 2) return '0';
    if (t < 0.82) return '[' + Array.from({ length: Math.floor(R() * 3) }, () => rv(d + 1)).join(',') + ']';
    return '{' + Array.from({ length: Math.floor(R() * 4) }, () => JSON.stringify(pick(['a', 'b', 'installed', 'baseline', 'checkedAt', 'case', 'counts', 'x'])) + ':' + rv(d + 1)).join(',') + '}';
  };
  const time = () => pick([off(-HOUR), off(-5 * HOUR), off(-DAY - 20000), off(-DAY + 20000), off(-2 * HOUR + 20000), off(-2 * HOUR - 20000), off(HOUR), 'null', '"x"', '0', '-1', '1e999'.replace('1e999', '1e308'), '1.5']);
  // an object text: each wanted key with a good value, a random value or absent; random extra keys; random order; random damage
  const obj = (fields, extra) => {
    const parts = [];
    for (const [k, good] of Object.entries(fields)) {
      const t = R();
      if (t < 0.12) continue;
      parts.push(JSON.stringify(k) + ':' + (t < 0.6 ? (typeof good === 'function' ? good() : good) : rv(0)));
    }
    for (let i = 0; i < Math.floor(R() * (extra || 3)); i++) parts.push(JSON.stringify(pick(['source', 'note', 'n', 'zz', 'lastAdvised', 'checkedAt'])) + ':' + rv(0));
    for (let i = parts.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [parts[i], parts[j]] = [parts[j], parts[i]]; }
    let text = '{' + parts.join(R() < 0.2 ? ' , ' : ',') + '}';
    const d = R();
    if (d < 0.04) text = text.slice(0, Math.floor(R() * text.length));
    else if (d < 0.08) text = ' \n' + text + '\n ';
    else if (d < 0.1) text = text + 'x';
    else if (d < 0.12) text = '﻿' + text;
    return text;
  };
  const out = [];
  const add = (i, files, extra) => out.push(Object.assign({ id: `${hook}-fuzz-${seed}-${i}`, hook, files, deferOk: true }, extra || {}));
  for (let i = 0; i < n; i++) {
    if (hook === 'claude-cli-version' || hook === 'devswarm-version') {
      const file = hook === 'claude-cli-version' ? 'claude-cli-version.json' : 'devswarm-version.json';
      const base = hook === 'claude-cli-version' ? '2.1.238' : '2.5.1';
      const inst = () => JSON.stringify(pick([base, base.replace(/\d+$/, '9'), base.replace(/^\d+\.\d+/, '9.9'), '2.2.0', '2.6.0', '1.0.0', ' 3.0.0 ', 'v9.9.9']));
      const la = () => obj({ installed: inst, baseline: JSON.stringify(base) }, 2);
      add(i, H('.anti-hall/' + file, obj({ installed: inst, checkedAt: time, lastAdvised: la }, 3)), { raw: undefined });
    } else if (hook === 'version-alert') {
      const latest = () => JSON.stringify(pick(['1.2.4', '1.3.0', 'v2.0.0', '1.2.3', '1.2', 'x', '1.2.4-beta', '9.9.9']));
      const key = () => obj({ case: JSON.stringify('update'), sessionId: JSON.stringify('sess-1'), latest, running: JSON.stringify('1.2.3') }, 1);
      const sid = pick(['sess-1', 'sess-1', 'other', '', 'é']);
      add(i, H('.anti-hall/version-check.json', obj({ latest, checkedAt: time, lastAdvised: key }, 3)), { plugin: { version: pick(['1.2.3', '1.2.3', '1.2', 'v1.2.3', '1.2.3-rc']) }, payload: pick([{ session_id: sid }, { session_id: sid }, { session_id: sid, agent_id: pick(['', 'a', 0]) }]) });
    } else if (hook === 'repo-self-drift') {
      const cnt = () => String(pick([49, 50, 15, 16, 2, 3]));
      const ck = () => obj({ claimedHooks: cnt, actualHooks: cnt, claimedSkills: cnt, actualSkills: cnt }, 1);
      const sk = () => obj({ modelKbAuditDate: JSON.stringify('2026-09-03') }, 1);
      const las = () => obj({ counts: ck, staleness: sk }, 2);
      add(i, H('.anti-hall/repo-self-drift.json', obj({ checkedAt: time, claimedHooks: cnt, actualHooks: cnt, claimedSkills: cnt, actualSkills: cnt, modelKbAuditDate: JSON.stringify('2026-09-03'), modelKbAgeDays: () => String(pick([10, 60, 61, 100, 1.5])), lastAdvised: las }, 3)), { plugin: { kbInstalled: '- Hooks: **1** `.js` files\nClaude skills: **1**\n' } });
    } else if (hook === 'defect-nudge') {
      const line = () => obj({ t: JSON.stringify(pick(['report', 'ruling', 'backfill', 'note'])), proj: JSON.stringify(pick(['proj', 'proj', 'other'])), status: JSON.stringify(pick(['fixed', 'open', 'ack', 'partial', 'dup', 'wontfix'])), fixedIn: JSON.stringify(pick(['1.0.0', '1.0.1', 'x', ''])), v: JSON.stringify(pick(['1.0.0', '1.0.1', '0.9.9', 'x'])), at: () => JSON.stringify(pick(['{{ISO-' + Math.round((1.5 + Math.floor(R() * 20)) * DAY) + '}}'])) }, 2);
      const lines = Array.from({ length: 1 + Math.floor(R() * 5) }, line);
      if (R() < 0.15) lines.splice(Math.floor(R() * lines.length), 0, pick(['', '[1]', '"x"', 'null', '{"t":']));
      const files = {};
      for (let f = 0; f < 1 + Math.floor(R() * 3); f++) files['home/.anti-hall/defects/' + 'f'.repeat(12 - 1) + f + '.jsonl'] = lines.map((l, k) => (R() < 0.5 ? l : lines[(k + f) % lines.length])).join(R() < 0.2 ? '\r\n' : '\n') + '\n';
      Object.assign(files, R() < 0.5 ? { 'proj/plugins/anti-hall/.claude-plugin/plugin.json': '{}' } : {});
      if (R() < 0.4) files['home/.anti-hall/.defects-nudge-stamp.json'] = obj({ lastSweep: time }, 1).replace(/\{\{NOW/g, '{{NOW');
      add(i, files);
    } else if (hook === 'progress-prune') {
      const files = {};
      const dates = ['2026-09-01', '2026-09-02', '{{TODAY}}', 'legacy', 'INDEX.md', 'weird name', '2026-9-1'];
      for (let f = 0; f < 1 + Math.floor(R() * 5); f++) files['proj/.anti-hall/progress/' + pick(dates) + '/' + pick(['s1', 's2', 'é', '.', 'a.md', 'x y']) + pick(['.md', '.md', '.txt', '.MD', '']) ] = { content: pick(['', 'a', 'a\r\nb\n', 'x\ry\r', 'é日本\n', '\n\n']) , mtimeOffset: pick([-30 * HOUR, -2 * HOUR, -8 * HOUR, 3 * HOUR, -400 * HOUR]) };
      if (R() < 0.3) files['proj/.anti-hall/history/2026-09-01/s1.md'] = pick(['old\n', '', 'no newline']);
      if (R() < 0.4) files['home/.anti-hall/progress-prune-state.json'] = obj({ '{{KEY}}': () => obj({ lastPrunedAt: time }, 1), other: () => rv(0) }, 2);
      if (R() < 0.3) files['home/.anti-hall/gitignore-hint-state.json'] = obj({ '{{PROJ}}': time }, 2);
      add(i, files, { git: R() < 0.8 ? ['proj'] : [], afterGit: R() < 0.5 ? { 'proj/.gitignore': '.anti-hall/\n' } : undefined, env: R() < 0.2 ? { ANTIHALL_GITIGNORE_HINT: 'off' } : {} });
    }
  }
  return out;
};
