'use strict';
// Release gate (v0.108.0, owner requirement): everything anti-hall ships is
// documented. Each list below is DERIVED from the code (schema, hooks.json,
// skill dirs, CLI switch statements, Jev call sites) — never hand-typed — and
// must appear in the docs named for it:
//   (1) every settings-schema key          -> docs/GUIDE.md
//   (2) every hook script in hooks.json    -> llms.txt  (Claude AND Codex manifests)
//   (3) every skill dir                    -> a table row in README.md / docs/README.md
//                                             (Codex skills: plugins/anti-hall/codex/README.md)
//   (4) every devswarm.js / jev-report.js / settings.js verb -> its skill or KB
//   (5) every Jev integration id           -> docs/KB-jev-classifier.md AND skills/jev/SKILL.md
//   (6) every setting key and verb above   -> the system-briefing operator guide
//                                             (Claude AND Codex mirrors)
// A failure names exactly what is undocumented and where it must go.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugins', 'anti-hall');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const schema = require(path.join(PLUGIN, 'hooks', 'lib', 'settings-schema.js'));
const SETTING_KEYS = [];
for (const sec of schema.SECTIONS) for (const s of sec.settings) SETTING_KEYS.push(sec.key + '.' + s.key);

const BRIEFINGS = [
  ['plugins/anti-hall/skills/system-briefing/SKILL.md', read('plugins', 'anti-hall', 'skills', 'system-briefing', 'SKILL.md')],
  ['plugins/anti-hall/codex/skills/anti-hall-system-briefing/SKILL.md', read('plugins', 'anti-hall', 'codex', 'skills', 'anti-hall-system-briefing', 'SKILL.md')],
];

function hookScripts(manifestRel) {
  const j = JSON.parse(read(manifestRel));
  const out = new Set();
  JSON.stringify(j).replace(/hooks\/([\w.-]+\.js)/g, (m, s) => { out.add(s); return m; });
  return [...out];
}

// Verbs of a CLI = the `case '<verb>':` labels of the named dispatch function
// (the same rule devswarm.js's own verbListFromSwitch uses for `help`).
function switchVerbs(rel, fnHeader) {
  const src = read(rel);
  const start = src.indexOf(fnHeader);
  assert.ok(start >= 0, fnHeader + ' not found in ' + rel);
  const next = src.indexOf('\nfunction ', start + fnHeader.length);
  const body = src.slice(start, next === -1 ? undefined : next);
  const verbs = [];
  body.replace(/case '([a-z][a-z0-9-]*)':/g, (m, v) => { if (!verbs.includes(v)) verbs.push(v); return m; });
  return verbs;
}
function jevReportVerbs() {
  const src = read('plugins/anti-hall/scripts/jev-report.js');
  const verbs = [];
  src.replace(/argv\[0\] === '([a-z][a-z-]*)'/g, (m, v) => { if (!verbs.includes(v)) verbs.push(v); return m; });
  return verbs;
}
// A verb is "documented" when it appears as code: `verb` or `verb … inside a code span.
const mentionsVerb = (text, verb) => new RegExp('`(?:[^`\\n]*[ /])?' + verb.replace(/-/g, '\\-') + '(?:[` ]|$)', 'm').test(text);

// Jev integration ids = the `id: '<x>'` passed to jev-assist/jev-triage by hooks
// that load them (doctor.js's own self-test ids excluded).
function jevIntegrationIds() {
  const ids = new Set();
  const dirs = [path.join(PLUGIN, 'hooks'), path.join(PLUGIN, 'hooks', 'lib')];
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.js') || f === 'doctor.js') continue;
      const src = fs.readFileSync(path.join(d, f), 'utf8');
      if (!/jev-assist|jev-triage|jev-client/.test(src) && f !== 'jev-triage.js') continue;
      src.replace(/\bid: '([a-zA-Z]+)'/g, (m, id) => { ids.add(id); return m; });
    }
  }
  return [...ids];
}

test('(1) every settings-schema key is documented in docs/GUIDE.md', () => {
  const guide = read('docs', 'GUIDE.md');
  const missing = SETTING_KEYS.filter((k) => !guide.includes('`' + k + '`'));
  assert.deepStrictEqual(missing, [], 'add these to the GUIDE settings table: ' + missing.join(', '));
});

test('(2) every hook script registered in hooks.json (Claude + Codex) is in llms.txt', () => {
  const llms = read('llms.txt');
  const all = new Set([...hookScripts('plugins/anti-hall/hooks/hooks.json'), ...hookScripts('plugins/anti-hall/codex/hooks/hooks.json')]);
  assert.ok(all.size > 30, 'parsed the hook manifests');
  const missing = [...all].filter((h) => !llms.includes(h));
  assert.deepStrictEqual(missing, [], 'add a llms.txt Hooks row for: ' + missing.join(', '));
});

test('(3) every skill dir has a table row (Claude: README.md or docs/README.md; Codex: codex/README.md)', () => {
  const rootDocs = read('README.md') + '\n' + read('docs', 'README.md');
  const rowFor = (text, name) => text.split('\n').some((l) => l.trim().startsWith('|') && l.includes('`' + name + '`'));
  const claude = fs.readdirSync(path.join(PLUGIN, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const missingClaude = claude.filter((n) => !rowFor(rootDocs, n));
  const codexReadme = read('plugins', 'anti-hall', 'codex', 'README.md');
  const codex = fs.readdirSync(path.join(PLUGIN, 'codex', 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const missingCodex = codex.filter((n) => !codexReadme.includes('`' + n + '`'));
  assert.deepStrictEqual({ missingClaude, missingCodex }, { missingClaude: [], missingCodex: [] });
});

test('(4) every devswarm.js / jev-report.js / settings.js verb is documented in its skill or KB', () => {
  const devswarmDocs = read('plugins/anti-hall/skills/devswarm/SKILL.md') + '\n' + read('docs/KB-devswarm-hivecontrol.md');
  const jevDocs = read('plugins/anti-hall/skills/jev/SKILL.md') + '\n' + read('docs/KB-jev-classifier.md');
  const settingsDocs = read('plugins/anti-hall/skills/settings/SKILL.md');
  const dv = switchVerbs('plugins/anti-hall/scripts/devswarm.js', 'function runArmed(');
  const jv = jevReportVerbs();
  const sv = switchVerbs('plugins/anti-hall/scripts/settings.js', 'function main(');
  assert.ok(dv.length > 30 && jv.length >= 2 && sv.length >= 4, 'parsed the verb lists: ' + [dv.length, jv.length, sv.length]);
  const missing = [
    ...dv.filter((v) => !mentionsVerb(devswarmDocs, v)).map((v) => 'devswarm.js ' + v + ' (skills/devswarm or KB-devswarm-hivecontrol)'),
    ...jv.filter((v) => !mentionsVerb(jevDocs, v)).map((v) => 'jev-report.js ' + v + ' (skills/jev or KB-jev-classifier)'),
    ...sv.filter((v) => !mentionsVerb(settingsDocs, v)).map((v) => 'settings.js ' + v + ' (skills/settings)'),
  ];
  assert.deepStrictEqual(missing, []);
});

test('(5) every Jev integration id is in docs/KB-jev-classifier.md and skills/jev/SKILL.md', () => {
  const ids = jevIntegrationIds();
  assert.ok(ids.length >= 7, 'found the Jev integrations: ' + ids.join(', '));
  const kb = read('docs', 'KB-jev-classifier.md');
  const skill = read('plugins', 'anti-hall', 'skills', 'jev', 'SKILL.md');
  const missing = ids.flatMap((id) => [
    ...(kb.includes('`' + id + '`') ? [] : [id + ' -> KB-jev-classifier.md']),
    ...(skill.includes('`' + id + '`') ? [] : [id + ' -> skills/jev/SKILL.md']),
  ]);
  assert.deepStrictEqual(missing, []);
});

test('(6) the system-briefing operator guide (Claude + Codex) lists every setting key and every CLI verb', () => {
  const dv = switchVerbs('plugins/anti-hall/scripts/devswarm.js', 'function runArmed(');
  const jv = jevReportVerbs();
  const sv = switchVerbs('plugins/anti-hall/scripts/settings.js', 'function main(');
  const out = [];
  for (const [name, text] of BRIEFINGS) {
    for (const k of SETTING_KEYS) if (!text.includes('`' + k + '`')) out.push(name + ': setting ' + k);
    for (const v of dv) if (!mentionsVerb(text, v)) out.push(name + ': devswarm.js ' + v);
    for (const v of jv) if (!mentionsVerb(text, v)) out.push(name + ': jev-report.js ' + v);
    for (const v of sv) if (!mentionsVerb(text, v)) out.push(name + ': settings.js ' + v);
  }
  assert.deepStrictEqual(out, []);
});

test('the SessionStart foundation points agents at the operator guide by name', () => {
  const src = read('plugins', 'anti-hall', 'hooks', 'verify-first-full.js');
  assert.match(src, /\/anti-hall:system-briefing \(Codex: anti-hall-system-briefing\)/);
});
