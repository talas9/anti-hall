'use strict';
// no-real-home-inbox-tick — a test that can EXECUTE a real `inbox tick` must not be
// able to read or write the developer's real ~/.anti-hall. Root cause guarded: tick
// reads the usage/limit cache, settings and mesh stores under HOME (inbox-cmd.js
// isConserving({ home })), so an un-isolated executor pollutes / depends on real state.
//
// DEFINITION. A source file EXECUTES a tick when its code (comments stripped) has any of:
//   - a call  cli.run / run / spawn* / exec*  whose args contain 'inbox' , 'tick' as
//     adjacent string literals (['inbox','tick',...]) — in-process or subprocess;
//   - tickInbox( ... ) / cmdInboxTick( ... );
//   - require('...inbox-cmd...').
// Strings that merely CONTAIN the words "inbox tick" (classifier inputs, docs) do not count.
// A file is ISOLATED when it requires helpers/isolate-home.js, or sets HOME and
// USERPROFILE (or `home:` for the in-process ctx) itself. Helper modules (non-*.test.js
// under tests/) that execute a tick propagate the obligation to every test file that
// requires them (by basename).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_ROOT = path.join(__dirname, '..');

const EXEC_RES = [
  /['"`]inbox['"`]\s*,\s*['"`]tick['"`]/,
  /\b(?:tickInbox|cmdInboxTick)\s*\(/,
  /require\(\s*['"`][^'"`]*inbox-cmd(?:\.js)?['"`]\s*\)/,
];
const ISOLATE_RE = /require\(\s*['"`][^'"`]*isolate-home(?:\.js)?['"`]\s*\)/;
const OWN_HOME_RE = /\b(?:HOME|USERPROFILE)\s*:|\bprocess\.env\.(?:HOME|USERPROFILE)\s*=/;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
const executesTick = (src) => { const c = stripComments(src); return EXEC_RES.some((re) => re.test(c)); };
const isolated = (src) => { const c = stripComments(src); return ISOLATE_RE.test(c) || OWN_HOME_RE.test(c); };

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// findViolations({ relPath: source }) -> relPath[] of un-isolated tick executors.
function findViolations(files) {
  const names = Object.keys(files);
  const helpers = names.filter((n) => !n.endsWith('.test.js') && executesTick(files[n]));
  const bad = [];
  for (const n of names) {
    if (!n.endsWith('.test.js')) continue;
    const src = files[n];
    const viaHelper = helpers.some((h) => {
      const base = path.basename(h).replace(/\.js$/, '');
      return new RegExp(`require\\(\\s*['"\`][^'"\`]*\\b${base}(?:\\.js)?['"\`]\\s*\\)`).test(stripComments(src));
    });
    if ((executesTick(src) || viaHelper) && !isolated(src)) bad.push(n);
  }
  return bad;
}

test('no test file can execute a real inbox tick without an isolated HOME', () => {
  const files = {};
  for (const f of walk(TESTS_ROOT)) files[path.relative(TESTS_ROOT, f)] = fs.readFileSync(f, 'utf8');
  assert.deepStrictEqual(findViolations(files), []);
});

test('detector is not vacuous: seeded violators are caught, clean/classifier files pass', () => {
  const iso = "require('../helpers/isolate-home.js');\n";
  const cases = {
    'a.test.js': "const r = cli.run(['inbox', 'tick', id], { cwd });",
    'b.test.js': "execFileSync(process.execPath, [launcher, 'inbox', 'tick', 'x'], { env });",
    'c.test.js': "const { tickInbox } = require('../../x/inbox-cmd.js'); tickInbox(ctx);",
    'd.test.js': iso + "cli.run(['inbox', 'tick', id], { home });",
    'e.test.js': "execFileSync(node, [l, 'inbox', 'tick'], { env: { ...process.env, HOME: h, USERPROFILE: h } });",
    'f.test.js': "assert.ok(classify('node devswarm.js inbox tick abc'));",
    'g.test.js': "// cli.run(['inbox','tick']) commented out\n",
    'helper.js': "exports.t = () => cli.run(['inbox', 'tick', 'r']);",
    'h.test.js': "const ops = require('./helper.js'); ops.t();",
    'i.test.js': iso + "const ops = require('./helper.js'); ops.t();",
  };
  assert.deepStrictEqual(findViolations(cases).sort(), ['a.test.js', 'b.test.js', 'c.test.js', 'h.test.js']);
});
