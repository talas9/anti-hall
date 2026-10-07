'use strict';
// contract-counts — the numbers docs/CONTRACT-1.0.md and docs/KB.md state about the
// shipped surface must equal the numbers computed from the code. Root cause this
// guards: the contract table drifted (239 vs 244 settings, 58 vs 59 hook scripts)
// because only a subset of KB.md counts was ever checked. Counts are computed here
// from the real files; each doc claim is located by a regex around a stable phrase
// and compared. A vacuous-test guard changes each claimed number in a copy of the
// doc and requires the comparison to FAIL, and requires every regex to match once.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const P = (...p) => path.join(REPO, 'plugins', 'anti-hall', ...p);
const read = (f) => fs.readFileSync(f, 'utf8');

function hookStats(manifest) {
  const j = JSON.parse(read(manifest));
  const scripts = new Set();
  let registrations = 0;
  const events = Object.keys(j.hooks || {});
  for (const groups of Object.values(j.hooks || {})) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        registrations++;
        const toks = String(h.command || '').match(/[\w.${}/-]+\.(?:js|mjs|cjs|sh)\b/g);
        if (toks) scripts.add(toks[toks.length - 1].split('/').pop());
      }
    }
  }
  return { scripts, registrations, events: events.length };
}

function computed() {
  const schema = require(P('hooks', 'lib', 'settings-schema.js'));
  const all = schema.allSettings();
  const claude = hookStats(P('hooks', 'hooks.registry.json'));
  const codex = hookStats(P('codex', 'hooks', 'hooks.registry.json'));
  const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  return {
    settings: all.length,
    sections: schema.SECTIONS.length,
    advanced: all.filter((s) => s.advanced).length,
    env: all.filter((s) => s.env).length,
    locked: all.filter((s) => s.locked).length,
    homeOnly: all.filter((s) => s.homeOnly).length,
    hookScripts: claude.scripts.size,
    hookRegs: claude.registrations,
    hookEvents: claude.events,
    codexScripts: codex.scripts.size,
    codexRegs: codex.registrations,
    codexEvents: codex.events,
    alsoCodex: [...claude.scripts].filter((s) => codex.scripts.has(s)).length,
    claudeSkills: dirs(P('skills')),
    codexSkills: dirs(P('codex', 'skills')),
    hookFiles: fs.readdirSync(P('hooks')).filter((f) => f.endsWith('.js')).length,
    userConfig: Object.keys(JSON.parse(read(P('.claude-plugin', 'plugin.json'))).userConfig || {}).length,
    // per-section key counts, addressed as `section:<key>`
    ...Object.fromEntries(schema.SECTIONS.map((s) => [`section:${s.key}`, s.settings.length])),
  };
}

// Each claim: regex with ONE capture group around the number, plus the computed key.
const W = '\\s*>?\\s*'; // tolerate blockquote line wraps
const CONTRACT = [
  ['settings keys (table)', /\| Settings keys \| (\d+) in \d+ sections/, 'settings'],
  ['settings sections (table)', /\| Settings keys \| \d+ in (\d+) sections/, 'sections'],
  ['hook scripts (table)', /\| Hook scripts \| (\d+) \(\d+ registrations, \d+ events\)/, 'hookScripts'],
  ['hook registrations (table)', /\| Hook scripts \| \d+ \((\d+) registrations, \d+ events\)/, 'hookRegs'],
  ['hook events (table)', /\| Hook scripts \| \d+ \(\d+ registrations, (\d+) events\)/, 'hookEvents'],
  ['codex hook scripts (table)', /\| Codex hook scripts \| (\d+) \(\d+ registrations, \d+ events\)/, 'codexScripts'],
  ['codex hook registrations (table)', /\| Codex hook scripts \| \d+ \((\d+) registrations, \d+ events\)/, 'codexRegs'],
  ['codex hook events (table)', /\| Codex hook scripts \| \d+ \(\d+ registrations, (\d+) events\)/, 'codexEvents'],
  ['claude skills (table)', /\| Skills \| (\d+) Claude, \d+ Codex/, 'claudeSkills'],
  ['codex skills (table)', /\| Skills \| \d+ Claude, (\d+) Codex/, 'codexSkills'],
  ['settings keys (prose)', /Of the (\d+) keys:/, 'settings'],
  ['advanced keys (prose)', /Of the \d+ keys: (\d+) are `advanced`/, 'advanced'],
  ['env-override keys (prose)', /Of the \d+ keys: \d+ are `advanced`[^]*?,\s*(\d+)\s+have an env override/, 'env'],
  ['locked keys (prose)', /have an env override, (\d+) are `locked`/, 'locked'],
  ['homeOnly keys (prose)', /(\d+) are `homeOnly`/, 'homeOnly'],
];
// One claim per schema section: the `Keys` cell of its row in the contract's section table.
const SECTION_ROWS = require(P('hooks', 'lib', 'settings-schema.js')).SECTIONS.map((s) => [
  `section "${s.key}" keys (table row)`,
  new RegExp('\\| `' + s.key + '` \\|[^|\\n]*\\| (\\d+) \\|'),
  `section:${s.key}`,
]);
CONTRACT.push(...SECTION_ROWS);
const GUIDE = [
  ['/config rows (intro)', /The `\/config` rows \((\d+) options\)/, 'userConfig'],
  ['userConfig options (settings notes)', /(\d+) `userConfig` options in `plugin\.json`/, 'userConfig'],
];
const KB = [
  ['hook files (re-verified note)', new RegExp('Hooks:\\s*\\*\\*(\\d+)\\*\\*\\s*`\\.js`\\s*files'), 'hookFiles'],
  ['registered scripts (note)', new RegExp('(\\d+) scripts registered in' + W + '`hooks\\.json`'), 'hookScripts'],
  ['also-in-codex (note)', new RegExp('(\\d+) of them also in' + W + '`codex/hooks/hooks\\.json`'), 'alsoCodex'],
  ['claude skills (note)', new RegExp('Claude' + W + 'skills:\\s*\\*\\*(\\d+)\\*\\*'), 'claudeSkills'],
  ['codex skills (note)', new RegExp('Codex' + W + 'skills:\\s*\\*\\*(\\d+)\\*\\*'), 'codexSkills'],
  ['hooks shipped row title', /\*\*Hooks shipped \((\d+) files\)\*\*/, 'hookFiles'],
  ['hooks shipped row files', /\| (\d+) `\.js` files under `plugins\/anti-hall\/hooks\/` \(incl\. shared modules\)/, 'hookFiles'],
  ['hooks shipped row registered', /(\d+) scripts registered in `hooks\.json`\. One row per hook/, 'hookScripts'],
  ['skills shipped row title', /\*\*Skills shipped \((\d+)\)\*\*/, 'claudeSkills'],
  ['skills shipped row codex', /Codex: (\d+) `anti-hall-\*` skills/, 'codexSkills'],
  ['PLUGIN-REVIEW skills line', /\*\*Current:\*\* (\d+) skills \[UPDATE/, 'claudeSkills'],
];

// mismatches(text, claims, real) -> list of human-readable problems.
function mismatches(text, claims, real, label) {
  const out = [];
  for (const [name, re, key] of claims) {
    const m = re.exec(text);
    if (!m) { out.push(`${label}: claim not found: ${name} (${re})`); continue; }
    if (Number(m[1]) !== real[key]) out.push(`${label}: ${name} says ${m[1]}, code says ${real[key]} (${key})`);
  }
  return out;
}

const withIndices = (re) => new RegExp(re.source, re.flags.includes('d') ? re.flags : re.flags + 'd');

const DOCS = [
  ['docs/CONTRACT-1.0.md', CONTRACT],
  ['docs/KB.md', KB],
  ['docs/GUIDE.md', GUIDE],
];
const real = computed();

for (const [rel, claims] of DOCS) {
  test(`${rel}: every stated count equals the computed one`, () => {
    const problems = mismatches(read(path.join(REPO, rel)), claims, real, rel);
    assert.deepStrictEqual(problems, []);
  });

  test(`${rel}: vacuous-test guard — changing any stated number is detected`, () => {
    const text = read(path.join(REPO, rel));
    for (const claim of claims) {
      const re = withIndices(claim[1]);
      const m = re.exec(text);
      assert.ok(m, `${rel}: regex must match: ${claim[0]}`);
      const start = m.indices[1][0];
      const num = m[1];
      const mutated = text.slice(0, start) + (Number(num) + 1) + text.slice(start + num.length);
      const probs = mismatches(mutated, [[claim[0], claim[1], claim[2]]], real, rel);
      assert.strictEqual(probs.length, 1, `${rel}: bumping "${claim[0]}" must fail the check`);
    }
  });
}

test('docs/CONTRACT-1.0.md: section table has one row per schema section, with matching headline keys', () => {
  const text = read(path.join(REPO, 'docs/CONTRACT-1.0.md'));
  const schema = require(P('hooks', 'lib', 'settings-schema.js'));
  const problems = [];
  const rows = text.match(/^\| `\w+` \| [^|\n]+ \| \d+ \|.*$/gm) || [];
  const docSections = rows.map((r) => /^\| `(\w+)`/.exec(r)[1]);
  const real = schema.SECTIONS.map((s) => s.key);
  for (const k of real) if (!docSections.includes(k)) problems.push(`section "${k}" missing from the contract table`);
  for (const k of docSections) if (!real.includes(k)) problems.push(`contract table lists section "${k}" which is not in the schema`);
  for (const s of schema.SECTIONS) {
    const row = rows.find((r) => r.startsWith('| `' + s.key + '` |'));
    if (!row) continue;
    const cell = row.split('|')[4] || '';
    const doc = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
    const code = s.settings.filter((k) => k.headline).map((k) => k.key).sort();
    if (doc.join(',') !== code.join(',')) problems.push(`section "${s.key}" headline keys: doc says [${doc}], code says [${code}]`);
  }
  assert.deepStrictEqual(problems, []);
});

test('computed counts are sane (non-zero)', () => {
  for (const [k, v] of Object.entries(real)) {
    if (k === 'locked' || k === 'homeOnly') continue;
    assert.ok(v > 0, `${k} computed as ${v}`);
  }
});
