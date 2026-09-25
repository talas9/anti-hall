'use strict';
// `devswarm.js help --short` — peer request (a DevSwarm Primary spent a day
// driving raw hivecontrol because it never discovered `devswarm.js archive`
// existed): one line per verb ("verb — purpose"), generated from the SAME
// source of truth as the full `help`/`help <verb>` listing (verbListFromSwitch()
// + VERB_HELP), so the short list can never drift from the real dispatcher.
//
// HOME isolation: every test uses a fresh mkdtemp'd home passed as ctx.home;
// nothing here ever touches the real ~/.anti-hall (repo rule).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const devswarmSrc = fs.readFileSync(
  path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js'),
  'utf8'
);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-help-short-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function snapshot(home) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(home, p));
    }
  }
  walk(home);
  return out.sort();
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

test('help --short: ok, code 0, one line per verb, zero side effects', () => {
  const home = tmpHome();
  try {
    const before = snapshot(home);
    const r = cli.run(['help', '--short'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.short, true);
    assert.equal(r.result.verb, null);
    assert.ok(Array.isArray(r.result.verbs) && r.result.verbs.length > 20);
    const lines = r.result.usage.split('\n');
    assert.equal(lines.length, r.result.verbs.length);
    for (const line of lines) {
      assert.match(line, /^[a-z][a-z0-9-]* — .+$/, `line should be "verb — purpose": ${line}`);
    }
    assert.deepEqual(snapshot(home), before);
  } finally { rm(home); }
});

test('--help --short: same short listing as help --short', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['--help', '--short'], ctx(home));
    assert.equal(r.result.short, true);
    assert.equal(r.result.action, 'help');
    const r2 = cli.run(['help', '--short'], ctx(home));
    assert.equal(r.result.usage, r2.result.usage);
  } finally { rm(home); }
});

test('help <verb> --short: verb given wins, falls back to the normal per-verb usage (not short)', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['help', 'migrate', '--short'], ctx(home));
    assert.equal(r.result.action, 'help');
    assert.equal(r.result.verb, 'migrate');
    assert.notEqual(r.result.short, true);
    assert.ok(r.result.usage.includes('usage: devswarm.js migrate'));
  } finally { rm(home); }
});

test('hygiene: every dispatcher case verb appears in the short list', () => {
  const home = tmpHome();
  try {
    // Independently scan the dispatcher's own switch statement (runArmed),
    // rather than reusing devswarm.js's verbListFromSwitch(), so this test
    // still catches drift if buildShortHelpText() is ever changed to use a
    // different or hand-typed list.
    const m = devswarmSrc.match(/function runArmed\(cmd, positionals, flags, ctx, argv\) \{[\s\S]*?\n\}\n/);
    assert.ok(m, 'could not locate runArmed() source for hygiene scan');
    const src = m[0];
    const caseRe = /case '([a-z][a-z0-9-]*)':/g;
    const dispatcherVerbs = [];
    let cm;
    while ((cm = caseRe.exec(src))) {
      if (!dispatcherVerbs.includes(cm[1])) dispatcherVerbs.push(cm[1]);
    }
    assert.ok(dispatcherVerbs.length > 20, 'sanity: hygiene scan found too few dispatcher verbs');

    const r = cli.run(['help', '--short'], ctx(home));
    const shortVerbs = r.result.usage.split('\n').map((line) => line.split(' — ')[0]);

    for (const verb of dispatcherVerbs) {
      assert.ok(
        shortVerbs.includes(verb),
        `dispatcher verb ${JSON.stringify(verb)} is missing from \`help --short\``
      );
    }
  } finally { rm(home); }
});
