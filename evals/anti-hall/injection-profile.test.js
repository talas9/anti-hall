'use strict';
// Tests for injection-profile.js: normalisation, hooks.json command lookup, listing counting
// rule, and one real profile of this checkout (self-checks, identity gate, determinism).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('./injection-profile.js');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

test('REP_ROOT is exactly 64 chars and expandRoot uses it', () => {
  assert.equal(P.REP_ROOT.length, 64);
  assert.equal(P.charsOf('<ROOT>/x'), 64 + 2);
});

test('normalise: paths, ISO timestamps, dates, epoch-ms', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-test-'));
  try {
    const ctx = { home, cwd: path.join(home, 'work'), root: path.join(home, 'plug') };
    const real = fs.realpathSync.native(home);
    const t = [
      'cwd ' + ctx.cwd + ' root ' + ctx.root + ' home ' + home,
      'real ' + path.join(real, 'work'),
      'at 2026-10-04T12:34:56.789Z on 2026-10-04 ms 1759581296789',
    ].join('\n');
    const n = P.normalise(t, ctx);
    assert.match(n, /cwd <CWD> root <ROOT> home <HOME>/);
    assert.match(n, /real <CWD>/);
    assert.match(n, /at <TS> on <DATE> ms <EPOCH>/);
    assert.ok(!n.includes(home) && !n.includes(real));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('normalise: /private/var and /var forms of the same dir both collapse', () => {
  const ctx = { home: '/private/var/folders/aa/h', cwd: '/private/var/folders/aa/c', root: '/x/root' };
  const n = P.normalise('/var/folders/aa/h/a /private/var/folders/aa/h/b /var/folders/aa/c/z', ctx);
  assert.equal(n, '<HOME>/a <HOME>/b <CWD>/z');
});

test('findCommand matches by script basename and keeps args', () => {
  const hooks = { hooks: { Stop: [{ hooks: [
    { command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/git-guard.js" --audit' },
    { command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/task-guard.js"' } ] }] } };
  assert.match(P.findCommand(hooks, 'Stop', 'git-guard.js'), /--audit$/);
  assert.equal(P.findCommand(hooks, 'Stop', 'guard.js'), null);
  assert.equal(P.findCommand(hooks, 'Start', 'task-guard.js'), null);
});

test('frontmatterScalars: counting rule unquotes description + when_to_use', () => {
  const f = P.frontmatterScalars('---\nname: x\ndescription: "a \\"q\\" b"\nwhen_to_use: \'it\'\'s\'\n---\nbody');
  assert.equal(f.description, 'a "q" b');
  assert.equal(f.when_to_use, "it's");
});

test('profile of this checkout: sizes sane, self-checks pass, identity gate, deterministic', () => {
  const rep = P.profile(PLUGIN, PLUGIN, { determinism: true });
  for (const side of ['before', 'after']) {
    const bad = rep.selfChecks[side].filter((c) => !c.ok);
    assert.deepEqual(bad, []);
  }
  assert.equal(rep.beforeVsBefore.identicalRatios, true);
  assert.equal(rep.determinism.identical, true, 'differing: ' + rep.determinism.differing);
  const m = rep.gate.mb;
  assert.ok(m.sessionStartChars > 1000 && m.subagentNormal > 1000 && m.listingChars > 1000);
  assert.equal(rep.gate.ratios.main, 1);
  // identity cannot meet the reduction thresholds: the gate must FAIL, not pass vacuously
  assert.equal(rep.gate.pass, false);
});

test('gate passes a genuine reduction and fails a channel increase', () => {
  const base = P.profileCheckout(PLUGIN, {});
  const clone = JSON.parse(JSON.stringify(base));
  for (const sc of Object.values(clone.scenarios)) {
    for (const o of sc.outputs) if (!o.skipped) { o.text = o.text.slice(0, Math.floor(o.text.length * 0.3)); o.chars = P.charsOf(o.text); }
  }
  clone.listing.claude.chars = Math.floor(base.listing.claude.chars * 0.3);
  const ok = P.gate(base, clone);
  assert.equal(ok.checks.find((c) => c.name === 'no channel increases').ok, true);
  assert.ok(ok.ratios.main < 0.6 && ok.ratios.subagentNormal < 0.55 && ok.ratios.codexHooks < 0.7);
  const worse = P.gate(clone, base); // growing = increase
  assert.equal(worse.checks.find((c) => c.name === 'no channel increases').ok, false);
});
